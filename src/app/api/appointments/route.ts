import { NextResponse } from 'next/server'
import { requireRole, toErrorResponse } from '@/lib/auth/account'
import { createAppointment } from '@/lib/ai/booking/manage'
import type { AiAgentConfig } from '@/types'

/**
 * POST /api/appointments
 * body: { contact_id, service, start_time, staff?, notes? }
 *
 * Manual booking creation — the CRM-side counterpart to the AI's
 * `create_booking` tool (src/lib/ai/tools.ts). Same validation
 * (business hours, service, conflict-check) via the shared
 * src/lib/ai/booking/manage.ts module, so a human agent can't create a
 * booking the AI itself would have rejected. Requires the 'agent' role,
 * matching the `appointments_insert` RLS policy (029_ai_booking.sql) —
 * enforced twice, once here for a clean 403 and once by Postgres as the
 * real backstop.
 */
export async function POST(request: Request) {
  try {
    const ctx = await requireRole('agent')
    const body = await request.json().catch(() => null)
    if (!body || typeof body !== 'object') {
      return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
    }

    const contactId = typeof body.contact_id === 'string' ? body.contact_id.trim() : ''
    const service = typeof body.service === 'string' ? body.service.trim() : ''
    const startTimeStr = typeof body.start_time === 'string' ? body.start_time.trim() : ''
    if (!contactId || !service || !startTimeStr) {
      return NextResponse.json(
        { error: 'contact_id, service, and start_time are required' },
        { status: 400 },
      )
    }
    const start = new Date(startTimeStr)
    if (Number.isNaN(start.getTime())) {
      return NextResponse.json({ error: 'start_time must be a valid date-time' }, { status: 400 })
    }

    // Belongs-to-account check happens implicitly via RLS on the
    // `contacts` select below — a contact_id from another account
    // resolves to no row rather than someone else's contact.
    const { data: contact, error: contactErr } = await ctx.supabase
      .from('contacts')
      .select('id')
      .eq('id', contactId)
      .eq('account_id', ctx.accountId)
      .maybeSingle()
    if (contactErr) {
      console.error('[appointments POST] contact lookup failed:', contactErr.message)
      return NextResponse.json({ error: 'Failed to look up contact' }, { status: 500 })
    }
    if (!contact) {
      return NextResponse.json({ error: 'Contact not found' }, { status: 404 })
    }

    const { data: configRow, error: configErr } = await ctx.supabase
      .from('ai_agent_config')
      .select('*')
      .eq('account_id', ctx.accountId)
      .maybeSingle()
    if (configErr) {
      console.error('[appointments POST] config lookup failed:', configErr.message)
      return NextResponse.json({ error: 'Failed to load business configuration' }, { status: 500 })
    }
    // Business hours live on ai_agent_config regardless of whether the AI
    // reply feature itself is enabled — an account can use manual booking
    // without ever turning the AI on. No row yet just means "no business
    // hours configured," which createAppointment already reports clearly.
    const config = (configRow ?? {
      services: [],
      business_hours: {},
      default_appointment_duration_minutes: 30,
    }) as AiAgentConfig

    const result = await createAppointment(ctx.supabase, {
      accountId: ctx.accountId,
      contactId,
      conversationId: null,
      config,
      service,
      start,
      notes: typeof body.notes === 'string' ? body.notes : null,
      staffName: typeof body.staff === 'string' ? body.staff.trim() : undefined,
      createdBy: 'human',
    })
    if (!result.created) {
      return NextResponse.json({ error: result.reason }, { status: 409 })
    }
    return NextResponse.json({ appointment: result }, { status: 201 })
  } catch (err) {
    return toErrorResponse(err)
  }
}
