import { NextResponse } from 'next/server'
import { requireRole, toErrorResponse } from '@/lib/auth/account'
import { sendAiReply } from '@/lib/whatsapp/ai-send'

/**
 * PATCH /api/ai/draft-replies/[id]
 * body: { action: 'approve' | 'reject' }
 *
 * Approve sends the draft's exact text (the same path runAiAgent uses
 * for a direct send, src/lib/whatsapp/ai-send.ts) and marks the row
 * `sent`. Reject just marks it `rejected` — used both for an explicit
 * reject and for the inbox's "Edit" action, which populates the
 * composer with the draft text and rejects the original so an agent's
 * edited version goes out through the normal manual-send path instead.
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

    const { data: draft, error: draftErr } = await ctx.supabase
      .from('ai_draft_replies')
      .select('*')
      .eq('id', id)
      .eq('account_id', ctx.accountId)
      .maybeSingle()
    if (draftErr) {
      console.error('[ai/draft-replies PATCH] fetch failed:', draftErr.message)
      return NextResponse.json({ error: 'Failed to load draft' }, { status: 500 })
    }
    if (!draft) {
      return NextResponse.json({ error: 'Draft not found' }, { status: 404 })
    }
    if (draft.status !== 'pending') {
      return NextResponse.json({ error: 'Draft has already been reviewed' }, { status: 409 })
    }

    if (action === 'reject') {
      const { error } = await ctx.supabase
        .from('ai_draft_replies')
        .update({ status: 'rejected', reviewed_by: ctx.userId, reviewed_at: new Date().toISOString() })
        .eq('id', id)
      if (error) {
        console.error('[ai/draft-replies PATCH] reject update failed:', error.message)
        return NextResponse.json({ error: 'Failed to reject draft' }, { status: 500 })
      }
      return NextResponse.json({ success: true, status: 'rejected' })
    }

    // Approve — need the conversation's contact_id, which the draft row
    // doesn't carry directly.
    const { data: conv, error: convErr } = await ctx.supabase
      .from('conversations')
      .select('contact_id')
      .eq('id', draft.conversation_id)
      .eq('account_id', ctx.accountId)
      .maybeSingle()
    if (convErr || !conv) {
      return NextResponse.json({ error: 'Conversation not found' }, { status: 404 })
    }

    try {
      await sendAiReply({
        accountId: ctx.accountId,
        userId: ctx.userId,
        conversationId: draft.conversation_id,
        contactId: conv.contact_id,
        text: draft.content_text,
      })
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      console.error('[ai/draft-replies PATCH] send failed:', message)
      return NextResponse.json({ error: `Send failed: ${message}` }, { status: 502 })
    }

    const { error: updateErr } = await ctx.supabase
      .from('ai_draft_replies')
      .update({ status: 'sent', reviewed_by: ctx.userId, reviewed_at: new Date().toISOString() })
      .eq('id', id)
    if (updateErr) {
      // The message already went out — log but don't fail the request
      // over a bookkeeping update.
      console.error('[ai/draft-replies PATCH] status update after send failed:', updateErr.message)
    }

    return NextResponse.json({ success: true, status: 'sent' })
  } catch (err) {
    return toErrorResponse(err)
  }
}
