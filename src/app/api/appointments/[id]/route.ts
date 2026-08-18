import { NextResponse } from 'next/server'
import { requireRole, toErrorResponse } from '@/lib/auth/account'
import { rescheduleAppointment, cancelAppointment } from '@/lib/ai/booking/manage'
import type { AiAgentConfig } from '@/types'

/**
 * PATCH /api/appointments/[id]
 * body: one of
 *   { status: 'cancelled' }                — cancel
 *   { new_start_time: <ISO> }              — reschedule
 *   { notes: string }                      — edit notes only
 *
 * Manual booking management — the CRM-side counterpart to the AI's
 * `reschedule_booking`/`cancel_booking` tools. Reschedule reuses the
 * same src/lib/ai/booking/manage.ts validation (business hours,
 * conflict-check) the AI tool uses, so a human agent can't put a
 * booking somewhere the AI itself would have rejected. Requires the
 * 'agent' role, matching the `appointments_update` RLS policy
 * (029_ai_booking.sql).
 */
export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const ctx = await requireRole('agent')
    const { id } = await params
    const body = await request.json().catch(() => null)
    if (!body || typeof body !== 'object') {
      return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
    }

    const { data: existing, error: fetchErr } = await ctx.supabase
      .from('appointments')
      .select('id, contact_id, status')
      .eq('id', id)
      .eq('account_id', ctx.accountId)
      .maybeSingle()
    if (fetchErr) {
      console.error('[appointments PATCH] lookup failed:', fetchErr.message)
      return NextResponse.json({ error: 'Failed to look up booking' }, { status: 500 })
    }
    if (!existing) {
      return NextResponse.json({ error: 'Booking not found' }, { status: 404 })
    }
    const appointment = existing as { id: string; contact_id: string; status: string }

    if (body.status === 'cancelled') {
      const result = await cancelAppointment(ctx.supabase, {
        accountId: ctx.accountId,
        contactId: appointment.contact_id,
        appointmentId: id,
      })
      if (!result.cancelled) {
        return NextResponse.json({ error: result.reason }, { status: 409 })
      }
      return NextResponse.json({ appointment: result })
    }

    if (typeof body.new_start_time === 'string' && body.new_start_time.trim()) {
      const newStart = new Date(body.new_start_time.trim())
      if (Number.isNaN(newStart.getTime())) {
        return NextResponse.json(
          { error: 'new_start_time must be a valid date-time' },
          { status: 400 },
        )
      }
      const { data: configRow, error: configErr } = await ctx.supabase
        .from('ai_agent_config')
        .select('*')
        .eq('account_id', ctx.accountId)
        .maybeSingle()
      if (configErr) {
        console.error('[appointments PATCH] config lookup failed:', configErr.message)
        return NextResponse.json(
          { error: 'Failed to load business configuration' },
          { status: 500 },
        )
      }
      const config = (configRow ?? {
        services: [],
        business_hours: {},
        default_appointment_duration_minutes: 30,
      }) as AiAgentConfig

      const result = await rescheduleAppointment(ctx.supabase, {
        accountId: ctx.accountId,
        contactId: appointment.contact_id,
        config,
        appointmentId: id,
        newStart,
      })
      if (!result.rescheduled) {
        return NextResponse.json({ error: result.reason }, { status: 409 })
      }
      return NextResponse.json({ appointment: result })
    }

    if (typeof body.notes === 'string') {
      const { data, error } = await ctx.supabase
        .from('appointments')
        .update({ notes: body.notes.trim() || null, updated_at: new Date().toISOString() })
        .eq('id', id)
        .eq('account_id', ctx.accountId)
        .select()
        .single()
      if (error) {
        console.error('[appointments PATCH] notes update failed:', error.message)
        return NextResponse.json({ error: 'Failed to update booking' }, { status: 500 })
      }
      return NextResponse.json({ appointment: data })
    }

    return NextResponse.json(
      { error: 'Provide status, new_start_time, or notes to update' },
      { status: 400 },
    )
  } catch (err) {
    return toErrorResponse(err)
  }
}
