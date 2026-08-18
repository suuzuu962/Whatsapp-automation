import { NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/ai/admin-client'
import {
  buildReminderText,
  buildReminderTemplateParams,
  sendBookingReminderMessage,
} from '@/lib/ai/booking/reminders'
import type { MessageTemplate } from '@/types'

/**
 * Sends due appointment reminders. Meant to be hit on a schedule
 * (Vercel Cron / GitHub Actions / external pinger) — re-uses
 * `AUTOMATION_CRON_SECRET` so operators only have one cron secret to
 * manage, same convention as /api/automations/cron and /api/flows/cron.
 *
 * For each account's configured offsets (ai_agent_config.
 * appointment_reminder_offsets_minutes — e.g. [1440, 120] for 24h/2h),
 * finds appointments starting inside a small window around
 * (now + offset) and sends a reminder for any that don't already have
 * one logged. The claim-row-first order in the loop below is what
 * makes this idempotent under overlapping cron ticks: the UNIQUE
 * (appointment_id, offset_minutes) constraint on `appointment_reminders`
 * means only one concurrent request wins the insert for a given
 * appointment+offset, so only one message ever goes out for it.
 */

// How wide a net each offset casts, in minutes. Must be >= the cron's
// actual firing interval or an appointment landing between two ticks
// could be missed entirely; 10 minutes comfortably covers a 5-minute
// cron cadence with room for jitter.
const WINDOW_MINUTES = 10

export async function GET(request: Request) {
  const expected = process.env.AUTOMATION_CRON_SECRET
  if (!expected) {
    return NextResponse.json({ error: 'cron not configured' }, { status: 503 })
  }
  const supplied = request.headers.get('x-cron-secret') ?? ''
  if (supplied !== expected) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const admin = supabaseAdmin()
  const { data: configs, error: configErr } = await admin
    .from('ai_agent_config')
    .select(
      'account_id, appointment_reminder_offsets_minutes, business_hours, reminder_template_name, reminder_template_language',
    )
  if (configErr) return NextResponse.json({ error: configErr.message }, { status: 500 })
  if (!configs || configs.length === 0) return NextResponse.json({ processed: 0 })

  const now = Date.now()
  let processed = 0

  for (const cfg of configs) {
    const offsets = (cfg.appointment_reminder_offsets_minutes as number[] | null) ?? []
    if (offsets.length === 0) continue
    const timezone = (cfg.business_hours as { timezone?: string } | null)?.timezone || 'UTC'
    const accountId = cfg.account_id as string

    // Loaded once per account, not per reminder — same N+1 avoidance as
    // the broadcast route's template-row load. A configured name that
    // doesn't resolve to an Approved row (never synced, since rejected,
    // renamed) falls back to free text rather than silently dropping
    // every reminder for the account.
    const templateName = cfg.reminder_template_name as string | null
    let template: MessageTemplate | null = null
    if (templateName) {
      const { data: templateRow } = await admin
        .from('message_templates')
        .select('*')
        .eq('account_id', accountId)
        .eq('name', templateName)
        .eq('language', (cfg.reminder_template_language as string | null) || 'en_US')
        .eq('status', 'Approved')
        .maybeSingle()
      template = (templateRow as MessageTemplate | null) ?? null
      if (!template) {
        console.warn(
          `[booking-reminders cron] configured reminder_template_name "${templateName}" has no Approved row for account ${accountId} — falling back to free-text send`,
        )
      }
    }

    for (const offsetMinutes of offsets) {
      const windowStart = new Date(now + offsetMinutes * 60_000).toISOString()
      const windowEnd = new Date(now + (offsetMinutes + WINDOW_MINUTES) * 60_000).toISOString()

      const { data: due, error: dueErr } = await admin
        .from('appointments')
        .select('id, contact_id, conversation_id, service, starts_at')
        .eq('account_id', accountId)
        .eq('status', 'booked')
        .gte('starts_at', windowStart)
        .lt('starts_at', windowEnd)
        .limit(200)
      if (dueErr) {
        console.error('[booking-reminders cron] due-appointments query failed:', dueErr.message)
        continue
      }
      if (!due || due.length === 0) continue

      for (const appt of due) {
        const conversationId = appt.conversation_id as string | null
        if (!conversationId) continue // no conversation to send/log the reminder into

        // Claim first — an insert conflict means another invocation
        // already handled (or is handling) this exact appointment +
        // offset, so skip sending a duplicate.
        const { error: claimErr } = await admin.from('appointment_reminders').insert({
          appointment_id: appt.id,
          account_id: accountId,
          offset_minutes: offsetMinutes,
        })
        if (claimErr) continue

        const { data: contact } = await admin
          .from('contacts')
          .select('phone, opted_out_at')
          .eq('id', appt.contact_id)
          .maybeSingle()
        if (!contact?.phone || contact.opted_out_at) continue

        const text = buildReminderText({
          service: appt.service as string,
          startsAt: appt.starts_at as string,
          timezone,
          offsetMinutes,
        })
        try {
          const sent = await sendBookingReminderMessage({
            accountId,
            conversationId,
            contactPhone: contact.phone as string,
            text,
            template,
            templateParams: template
              ? buildReminderTemplateParams({
                  service: appt.service as string,
                  startsAt: appt.starts_at as string,
                  timezone,
                })
              : undefined,
          })
          if (sent) processed++
        } catch (err) {
          console.error('[booking-reminders cron] send failed:', err)
        }
      }
    }
  }

  return NextResponse.json({ processed })
}
