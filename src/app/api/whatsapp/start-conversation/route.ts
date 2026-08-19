import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { sendTemplateMessage } from '@/lib/whatsapp/meta-api'
import { decrypt, encrypt, isLegacyFormat } from '@/lib/whatsapp/encryption'
import { supabaseAdmin } from '@/lib/flows/admin-client'
import {
  sanitizePhoneForMeta,
  isValidE164,
  phoneVariants,
  isRecipientNotAllowedError,
  recipientNotAllowedMessage,
} from '@/lib/whatsapp/phone-utils'
import {
  checkRateLimit,
  rateLimitResponse,
  RATE_LIMITS,
} from '@/lib/rate-limit'
import { ContactOptedOutError, assertNotOptedOut } from '@/lib/whatsapp/opt-out'
import { findOrCreateContact, findOrCreateConversation } from '@/lib/whatsapp/conversation-lookup'
import type { MessageTemplate } from '@/types'
import { isMessageTemplate } from '@/lib/whatsapp/template-row-guard'

/**
 * Starts a brand-new WhatsApp conversation: resolves/creates the
 * contact, resolves/creates the conversation, and sends the first
 * message as an approved template (WhatsApp requires a template for
 * any business-initiated message to a recipient outside the 24h
 * customer-service window — which is always true for a first
 * message). Mirrors src/app/api/whatsapp/send/route.ts's auth/send/
 * persist pattern, but that route requires an existing
 * conversation_id, so it can't be reused directly for a first contact.
 */
export async function POST(request: Request) {
  try {
    const supabase = await createClient()

    const {
      data: { user },
      error: authError,
    } = await supabase.auth.getUser()

    if (authError || !user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    // Same bucket as /send — this is a send.
    const limit = checkRateLimit(`send:${user.id}`, RATE_LIMITS.send)
    if (!limit.success) {
      return rateLimitResponse(limit)
    }

    const { data: profile } = await supabase
      .from('profiles')
      .select('account_id')
      .eq('user_id', user.id)
      .maybeSingle()
    const accountId = profile?.account_id as string | undefined
    if (!accountId) {
      return NextResponse.json(
        { error: 'Your profile is not linked to an account.' },
        { status: 403 },
      )
    }

    const body = await request.json()
    const {
      contact_id,
      phone,
      name,
      template_name,
      template_language,
      template_params,
      template_message_params,
    } = body

    if (!contact_id && !phone) {
      return NextResponse.json(
        { error: 'contact_id or phone is required' },
        { status: 400 },
      )
    }
    if (!template_name) {
      return NextResponse.json(
        { error: 'template_name is required to start a new conversation' },
        { status: 400 },
      )
    }

    // Resolve the contact: an existing one by id, or find-or-create by phone.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let contact: any
    if (contact_id) {
      const { data, error } = await supabase
        .from('contacts')
        .select('*')
        .eq('id', contact_id)
        .eq('account_id', accountId)
        .single()
      if (error || !data) {
        return NextResponse.json({ error: 'Contact not found' }, { status: 404 })
      }
      contact = data
    } else {
      const sanitized = sanitizePhoneForMeta(phone)
      if (!isValidE164(sanitized)) {
        return NextResponse.json(
          { error: 'Invalid phone number format' },
          { status: 400 },
        )
      }
      const outcome = await findOrCreateContact(accountId, user.id, sanitized, name || sanitized)
      if (!outcome) {
        return NextResponse.json(
          { error: 'Failed to create contact' },
          { status: 500 },
        )
      }
      contact = outcome.contact
    }

    if (!contact.phone) {
      return NextResponse.json(
        { error: 'Contact phone number not found' },
        { status: 400 },
      )
    }
    try {
      assertNotOptedOut(contact)
    } catch (err) {
      if (err instanceof ContactOptedOutError) {
        return NextResponse.json({ error: err.message }, { status: 403 })
      }
      throw err
    }

    const sanitizedPhone = sanitizePhoneForMeta(contact.phone)
    if (!isValidE164(sanitizedPhone)) {
      return NextResponse.json(
        { error: 'Invalid phone number format' },
        { status: 400 },
      )
    }

    const conversation = await findOrCreateConversation(accountId, user.id, contact.id)
    if (!conversation) {
      return NextResponse.json(
        { error: 'Failed to create conversation' },
        { status: 500 },
      )
    }

    const { data: config, error: configError } = await supabase
      .from('whatsapp_config')
      .select('*')
      .eq('account_id', accountId)
      .single()

    if (configError || !config) {
      return NextResponse.json(
        { error: 'WhatsApp not configured. Please set up your WhatsApp integration first.' },
        { status: 400 },
      )
    }

    const accessToken = decrypt(config.access_token)

    // Self-heal legacy CBC-encrypted tokens, same as /send.
    if (isLegacyFormat(config.access_token)) {
      void supabase
        .from('whatsapp_config')
        .update({ access_token: encrypt(accessToken) })
        .eq('id', config.id)
        .then(({ error }) => {
          if (error) {
            console.warn(
              '[whatsapp/start-conversation] access_token GCM upgrade failed:',
              error.message,
            )
          }
        })
    }

    let templateRow: MessageTemplate | null = null
    {
      const { data } = await supabase
        .from('message_templates')
        .select('*')
        .eq('account_id', accountId)
        .eq('name', template_name)
        .eq('language', template_language || 'en_US')
        .maybeSingle()
      if (data && !isMessageTemplate(data)) {
        return NextResponse.json(
          {
            error:
              'Template row is malformed locally — run "Sync from Meta" in Settings to repair it.',
          },
          { status: 500 },
        )
      }
      templateRow = data ?? null
    }

    // Same phone-format retry loop as /send.
    let waMessageId = ''
    let workingPhone = sanitizedPhone
    try {
      const variants = phoneVariants(sanitizedPhone)
      let lastError: unknown = null

      for (const variant of variants) {
        try {
          const result = await sendTemplateMessage({
            phoneNumberId: config.phone_number_id,
            accessToken,
            to: variant,
            templateName: template_name,
            language: template_language || 'en_US',
            template: templateRow ?? undefined,
            messageParams: template_message_params ?? undefined,
            params: template_params || [],
          })
          waMessageId = result.messageId
          workingPhone = variant
          lastError = null
          break
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err)
          if (!isRecipientNotAllowedError(message)) {
            throw err
          }
          lastError = err
          console.warn(`[whatsapp/start-conversation] variant "${variant}" rejected by Meta, trying next…`)
        }
      }

      if (lastError) throw lastError
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Unknown Meta API error'
      console.error('Meta API send failed for all variants:', message)
      if (isRecipientNotAllowedError(message)) {
        return NextResponse.json(
          { error: recipientNotAllowedMessage(), code: 'recipient_not_allowed' },
          { status: 403 },
        )
      }
      return NextResponse.json(
        { error: `Meta API error: ${message}` },
        { status: 502 },
      )
    }

    if (workingPhone !== sanitizedPhone) {
      await supabase
        .from('contacts')
        .update({ phone: workingPhone })
        .eq('id', contact.id)
    }

    const { data: messageRecord, error: msgError } = await supabase
      .from('messages')
      .insert({
        conversation_id: conversation.id,
        sender_type: 'agent',
        content_type: 'template',
        content_text: null,
        template_name,
        message_id: waMessageId,
        status: 'sent',
      })
      .select()
      .single()

    if (msgError) {
      console.error('Error inserting sent message:', msgError)
      return NextResponse.json(
        { error: `Message sent to Meta but failed to save to DB: ${msgError.message}` },
        { status: 500 },
      )
    }

    await supabase
      .from('conversations')
      .update({
        last_message_text: `[template] ${template_name}`,
        last_message_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      })
      .eq('id', conversation.id)

    // Defensive — mirrors /send's pause-on-agent-send. A brand new
    // contact can't have an active flow run, but an operator may be
    // starting a conversation with an existing contact_id that does.
    try {
      const { error: pauseErr } = await supabaseAdmin()
        .from('flow_runs')
        .update({
          status: 'paused_by_agent',
          ended_at: new Date().toISOString(),
          end_reason: 'agent_replied',
        })
        .eq('account_id', accountId)
        .eq('contact_id', contact.id)
        .eq('status', 'active')
      if (pauseErr) {
        console.error('[flows] pause-on-agent-send failed:', pauseErr.message)
      }
    } catch (err) {
      console.error(
        '[flows] pause-on-agent-send threw:',
        err instanceof Error ? err.message : err,
      )
    }

    return NextResponse.json({
      success: true,
      conversation_id: conversation.id,
      message_id: messageRecord.id,
      whatsapp_message_id: waMessageId,
    })
  } catch (error) {
    console.error('Error in WhatsApp start-conversation POST:', error)
    return NextResponse.json(
      { error: 'Failed to start conversation' },
      { status: 500 },
    )
  }
}
