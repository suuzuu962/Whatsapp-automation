import { NextResponse } from 'next/server'
import { requireRole, toErrorResponse } from '@/lib/auth/account'

const DEFAULT_LIMIT = 50
const MAX_LIMIT = 200

/**
 * GET /api/ai/audit-log?limit=50
 *
 * Most recent guardrail events for the caller's account — admin-only
 * (matches ai_audit_log's RLS select policy: is_account_member(account_id,
 * 'admin')). Used by the "Recent guardrail activity" panel under
 * Settings → AI Agent.
 */
export async function GET(request: Request) {
  try {
    const ctx = await requireRole('admin')
    const { searchParams } = new URL(request.url)
    const requested = Number(searchParams.get('limit'))
    const limit = Number.isFinite(requested) && requested > 0
      ? Math.min(requested, MAX_LIMIT)
      : DEFAULT_LIMIT

    const { data, error } = await ctx.supabase
      .from('ai_audit_log')
      .select('*')
      .eq('account_id', ctx.accountId)
      .order('created_at', { ascending: false })
      .limit(limit)
    if (error) {
      console.error('[ai/audit-log GET] fetch failed:', error.message)
      return NextResponse.json({ error: 'Failed to load audit log' }, { status: 500 })
    }
    return NextResponse.json({ events: data ?? [] })
  } catch (err) {
    return toErrorResponse(err)
  }
}
