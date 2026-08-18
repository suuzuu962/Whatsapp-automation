import { NextResponse } from 'next/server'
import { requireRole, toErrorResponse } from '@/lib/auth/account'
import { supabaseAdmin } from '@/lib/ai/admin-client'
import { logAuditEvent } from '@/lib/ai/guardrails/audit'
import { executeTool, type ToolContext } from '@/lib/ai/tools'
import type { AiAgentConfig } from '@/types'

/**
 * PATCH /api/ai/pending-actions/[id]
 * body: { action: 'approve' | 'reject' }
 *
 * A pending action is a consequential tool call (update_customer /
 * create_lead) the agent queued instead of executing because the
 * account has `consequential_action_mode: 'require_approval'` — see
 * runAiAgent's tool-calling loop (src/lib/ai/agent.ts) and
 * src/lib/ai/guardrails/consequential.ts. Approve actually runs the
 * tool now, against the same hard-scoped (accountId, contactId,
 * conversationId) it was bound to when generated — never against
 * anything the request body supplies. Reject just discards it.
 */
export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const ctx = await requireRole('agent')
    const { id } = await params
    const body = await request.json().catch(() => null)
    const action = body?.action

    if (action !== 'approve' && action !== 'reject') {
      return NextResponse.json({ error: "action must be 'approve' or 'reject'" }, { status: 400 })
    }

    const { data: pending, error: pendingErr } = await ctx.supabase
      .from('ai_pending_actions')
      .select('*')
      .eq('id', id)
      .eq('account_id', ctx.accountId)
      .maybeSingle()
    if (pendingErr) {
      console.error('[ai/pending-actions PATCH] fetch failed:', pendingErr.message)
      return NextResponse.json({ error: 'Failed to load pending action' }, { status: 500 })
    }
    if (!pending) {
      return NextResponse.json({ error: 'Pending action not found' }, { status: 404 })
    }
    if (pending.status !== 'pending') {
      return NextResponse.json({ error: 'This action has already been reviewed' }, { status: 409 })
    }

    if (action === 'reject') {
      const { error } = await ctx.supabase
        .from('ai_pending_actions')
        .update({ status: 'rejected', reviewed_by: ctx.userId, reviewed_at: new Date().toISOString() })
        .eq('id', id)
      if (error) {
        console.error('[ai/pending-actions PATCH] reject update failed:', error.message)
        return NextResponse.json({ error: 'Failed to reject action' }, { status: 500 })
      }
      await logAuditEvent(supabaseAdmin(), {
        accountId: ctx.accountId,
        conversationId: pending.conversation_id,
        eventType: 'action_rejected',
        severity: 'info',
        detail: { tool: pending.tool_name, pendingActionId: id },
      })
      return NextResponse.json({ success: true, status: 'rejected' })
    }

    // Approve — reload the account's current AI config so the executor
    // has fresh default_pipeline_id/default_stage_id etc., same as a
    // live agent turn would.
    const { data: configRow, error: configErr } = await ctx.supabase
      .from('ai_agent_config')
      .select('*')
      .eq('account_id', ctx.accountId)
      .maybeSingle()
    if (configErr || !configRow) {
      return NextResponse.json({ error: 'AI agent configuration not found' }, { status: 404 })
    }

    const toolCtx: ToolContext = {
      accountId: ctx.accountId,
      contactId: pending.contact_id,
      conversationId: pending.conversation_id,
      config: configRow as AiAgentConfig,
    }

    const result = await executeTool(
      toolCtx,
      pending.tool_name as string,
      (pending.tool_arguments as Record<string, unknown>) ?? {},
    )

    const { error: updateErr } = await ctx.supabase
      .from('ai_pending_actions')
      .update({
        status: 'approved',
        result,
        reviewed_by: ctx.userId,
        reviewed_at: new Date().toISOString(),
      })
      .eq('id', id)
    if (updateErr) {
      // The tool already ran — log but don't fail the request over a
      // bookkeeping update, same convention as the draft-replies route.
      console.error('[ai/pending-actions PATCH] status update after execute failed:', updateErr.message)
    }

    await logAuditEvent(supabaseAdmin(), {
      accountId: ctx.accountId,
      conversationId: pending.conversation_id,
      eventType: 'action_approved',
      severity: 'info',
      detail: { tool: pending.tool_name, pendingActionId: id, result },
    })

    return NextResponse.json({ success: true, status: 'approved', result })
  } catch (err) {
    return toErrorResponse(err)
  }
}
