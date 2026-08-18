import { supabaseAdmin } from '../admin-client'
import { sendTextMessage, sendTemplateMessage } from '@/lib/whatsapp/meta-api'
import { decrypt } from '@/lib/whatsapp/encryption'
import {
  sanitizePhoneForMeta,
  isValidE164,
  phoneVariants,
  isRecipientNotAllowedError,
} from '@/lib/whatsapp/phone-utils'
import type { MessageTemplate } from '@/types'

/**
 * Appointment reminders — sent by the cron route
 * (src/app/api/ai/booking-reminders/cron/route.ts), never by the AI
 * reply loop. Same send shape as ai-send.ts (contact lookup, phone
 * sanitize/variant-retry, sendTextMessage, messages insert,
 * conversation bump) but its own module since the caller already has
 * the phone number and conversation id on hand (loaded once for the
 * whole cron sweep) rather than an accountId/contactId pair to resolve.
 */

function formatReminderWhen(startsAt: string, timezone: string): string {
  return new Date(startsAt).toLocaleString('en-US', {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    timeZone: timezone,
  })
}

function formatReminderLead(offsetMinutes: number): string {
  return offsetMinutes >= 60
    ? `${Math.round(offsetMinutes / 60)} hour${Math.round(offsetMinutes / 60) === 1 ? '' : 's'}`
    : `${offsetMinutes} minutes`
}

/** Builds the reminder text for the free-text send path. Pure and
 *  separately unit-tested — the cron route itself isn't (no DB-free way
 *  to exercise it, consistent with the other cron routes in this
 *  codebase not being unit tested either; this function is the part of
 *  that route worth testing in isolation). */
export function buildReminderText(params: {
  service: string
  startsAt: string
  timezone: string
  offsetMinutes: number
}): string {
  const when = formatReminderWhen(params.startsAt, params.timezone)
  const lead = formatReminderLead(params.offsetMinutes)
  return `Reminder: your ${params.service} appointment is in ${lead}, on ${when}.`
}

/** Positional body variables ({{1}}, {{2}}) for the template send path
 *  — service name and formatted time, in that order. A business
 *  configuring `reminder_template_name` is expected to author a
 *  template whose body matches this shape, e.g. "Reminder: your {{1}}
 *  appointment is on {{2}}." */
export function buildReminderTemplateParams(params: {
  service: string
  startsAt: string
  timezone: string
}): string[] {
  return [params.service, formatReminderWhen(params.startsAt, params.timezone)]
}

/** Sends a reminder — via an approved template when one's configured
 *  (`template` + `templateParams` both set; required outside Meta's
 *  24h session window, see the module-level rationale in
 *  034_ai_booking_reminder_template.sql), otherwise as free text (only
 *  reliable inside that window). Records the send in `messages` /
 *  `conversations` like any other bot-sent message either way. Returns
 *  whether it actually went out — false (not thrown) for expected
 *  non-fatal cases (invalid phone, no WhatsApp config, Meta rejected
 *  every phone variant or the template) so the cron loop can move on to
 *  the next reminder. */
export async function sendBookingReminderMessage(params: {
  accountId: string
  conversationId: string
  contactPhone: string
  text: string
  template?: MessageTemplate | null
  templateParams?: string[]
}): Promise<boolean> {
  const db = supabaseAdmin()
  const sanitized = sanitizePhoneForMeta(params.contactPhone)
  if (!isValidE164(sanitized)) return false

  const { data: config } = await db
    .from('whatsapp_config')
    .select('*')
    .eq('account_id', params.accountId)
    .maybeSingle()
  if (!config) return false

  const accessToken = decrypt(config.access_token)
  let waMessageId = ''
  for (const variant of phoneVariants(sanitized)) {
    try {
      const r = params.template
        ? await sendTemplateMessage({
            phoneNumberId: config.phone_number_id,
            accessToken,
            to: variant,
            templateName: params.template.name,
            language: params.template.language || 'en_US',
            params: params.templateParams,
            template: params.template,
          })
        : await sendTextMessage({
            phoneNumberId: config.phone_number_id,
            accessToken,
            to: variant,
            text: params.text,
          })
      waMessageId = r.messageId
      break
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      if (!isRecipientNotAllowedError(msg)) throw err
    }
  }
  if (!waMessageId) return false

  await db.from('messages').insert({
    conversation_id: params.conversationId,
    sender_type: 'bot',
    content_type: 'text',
    content_text: params.text,
    message_id: waMessageId,
    status: 'sent',
  })
  await db
    .from('conversations')
    .update({
      last_message_text: params.text,
      last_message_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    })
    .eq('id', params.conversationId)

  return true
}
