import { NextResponse } from 'next/server'
import { getCurrentAccount, requireRole, toErrorResponse } from '@/lib/auth/account'

/**
 * GET /api/ai/staff
 *
 * Lists this account's staff members (any role can read — the booking
 * tools' auto-assignment logic in src/lib/ai/tools.ts reads them via
 * the service-role client directly, this route is purely for the
 * Settings UI). Ordered by creation so the wizard's list stays stable.
 */
export async function GET() {
  try {
    const ctx = await getCurrentAccount()
    const { data, error } = await ctx.supabase
      .from('staff_members')
      .select('*')
      .eq('account_id', ctx.accountId)
      .order('created_at', { ascending: true })
    if (error) {
      console.error('[ai/staff GET] fetch failed:', error.message)
      return NextResponse.json({ error: 'Failed to load staff' }, { status: 500 })
    }
    return NextResponse.json({ staff: data ?? [] })
  } catch (err) {
    return toErrorResponse(err)
  }
}

/**
 * POST /api/ai/staff
 * body: { name: string }
 *
 * Admin-only, matching ai_agent_config's write policy. New staff start
 * active with no custom working_hours (inherits the account's business
 * hours — see 031_ai_staff_booking.sql).
 */
export async function POST(request: Request) {
  try {
    const ctx = await requireRole('admin')
    const body = await request.json().catch(() => null)
    const name = typeof body?.name === 'string' ? body.name.trim() : ''
    if (!name) {
      return NextResponse.json({ error: 'name is required' }, { status: 400 })
    }

    const { data, error } = await ctx.supabase
      .from('staff_members')
      .insert({ account_id: ctx.accountId, name, active: true, working_hours: [] })
      .select()
      .single()
    if (error) {
      console.error('[ai/staff POST] insert failed:', error.message)
      return NextResponse.json({ error: 'Failed to add staff member' }, { status: 500 })
    }
    return NextResponse.json({ staff: data })
  } catch (err) {
    return toErrorResponse(err)
  }
}
