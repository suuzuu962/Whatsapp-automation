import { NextResponse } from 'next/server'
import { requireRole, toErrorResponse } from '@/lib/auth/account'

/**
 * PATCH /api/ai/staff/[id]
 * body: { name?, active?, working_hours? }
 *
 * Admin-only. `working_hours: []` means "inherit the account's business
 * hours" — see 031_ai_staff_booking.sql.
 */
export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const ctx = await requireRole('admin')
    const { id } = await params
    const body = await request.json().catch(() => null)
    if (!body) {
      return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
    }

    const update: Record<string, unknown> = {}
    if (typeof body.name === 'string' && body.name.trim()) update.name = body.name.trim()
    if (typeof body.active === 'boolean') update.active = body.active
    if (Array.isArray(body.working_hours)) update.working_hours = body.working_hours
    if (Object.keys(update).length === 0) {
      return NextResponse.json({ error: 'No valid fields to update' }, { status: 400 })
    }
    update.updated_at = new Date().toISOString()

    const { data, error } = await ctx.supabase
      .from('staff_members')
      .update(update)
      .eq('id', id)
      .eq('account_id', ctx.accountId)
      .select()
      .single()
    if (error) {
      console.error('[ai/staff PATCH] update failed:', error.message)
      return NextResponse.json({ error: 'Failed to update staff member' }, { status: 500 })
    }
    return NextResponse.json({ staff: data })
  } catch (err) {
    return toErrorResponse(err)
  }
}

/**
 * DELETE /api/ai/staff/[id]
 *
 * Admin-only. Existing appointments keep their staff_id set NULL by the
 * FK's ON DELETE SET NULL (031_ai_staff_booking.sql) rather than being
 * deleted — a booking history shouldn't vanish because a staff member
 * left.
 */
export async function DELETE(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const ctx = await requireRole('admin')
    const { id } = await params
    const { error } = await ctx.supabase
      .from('staff_members')
      .delete()
      .eq('id', id)
      .eq('account_id', ctx.accountId)
    if (error) {
      console.error('[ai/staff DELETE] delete failed:', error.message)
      return NextResponse.json({ error: 'Failed to remove staff member' }, { status: 500 })
    }
    return NextResponse.json({ success: true })
  } catch (err) {
    return toErrorResponse(err)
  }
}
