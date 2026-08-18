import type { AiAgentConfig } from '@/types'
import { sendAiReply } from '@/lib/whatsapp/ai-send'
import { supabaseAdmin } from './admin-client'
import { buildSystemPrompt } from './prompt'
import {
  classifyInboundText,
  classifyAbuse,
  INPUT_REINFORCEMENT_NOTE,
  ABUSE_BOUNDARY_MESSAGE,
} from './guardrails/input-classifier'
import { checkOutputForLeak, OUTPUT_BLOCKED_FALLBACK_TEXT } from './guardrails/output-guard'
import { isConsequentialTool, GATED_TOOL_RESULT } from './guardrails/consequential'
import { logAuditEvent } from './guardrails/audit'
import {
  buildAvailableProviders,
  generateWithFallback,
  orderProviders,
} from './providers/router'
import type { ChatMessage, GenerateReplyOutput, LlmProvider } from './providers/types'
import { executeTool, listToolSchemas, type ToolContext, type ToolResult } from './tools'

// ------------------------------------------------------------
// AI reply engine — single entry point, mirroring the shape of
// dispatchInboundToFlows (src/lib/flows/engine.ts). Called by the
// webhook only after Flows didn't consume the message and no keyword
// automation matched (see webhook/route.ts) — deterministic rules
// always get first crack; the AI is the fallback, not the default path.
//
// Guardrails (Phase 2) live at three points in this function, each
// documented at its own site below:
//   - input classification, right after the mode gate — src/lib/ai/guardrails/input-classifier.ts
//   - consequential-action gating, inside the tool-calling loop — src/lib/ai/guardrails/consequential.ts
//   - output-leak checking, right before a reply is sent/drafted — src/lib/ai/guardrails/output-guard.ts
// Every guardrail event that fires is written to `ai_audit_log` via
// src/lib/ai/guardrails/audit.ts — the append-only trail an admin can
// review under Settings → AI Agent.
// ------------------------------------------------------------

const HISTORY_LIMIT = 20
// Safety cap on the generate -> tool -> generate loop, same defensive
// role as the Flows engine's advance-loop cap (flows/engine.ts:556).
const MAX_TOOL_ROUNDS = 4

export interface RunAiAgentInput {
  accountId: string
  userId: string
  contactId: string
  conversationId: string
  inboundText: string
}

export async function runAiAgent(
  input: RunAiAgentInput,
): Promise<{ handled: boolean }> {
  const db = supabaseAdmin()

  const { data: configRow, error: configErr } = await db
    .from('ai_agent_config')
    .select('*')
    .eq('account_id', input.accountId)
    .maybeSingle()
  if (configErr) {
    console.error('[ai] config lookup failed:', configErr.message)
    return { handled: false }
  }
  const config = configRow as AiAgentConfig | null
  if (!config || !config.enabled) {
    return { handled: false }
  }

  const providers = orderProviders(
    buildAvailableProviders(),
    config.provider_priority ?? [],
  )
  if (providers.length === 0) {
    console.warn(
      '[ai] agent enabled but no provider API key configured — set ANTHROPIC_API_KEY or OPENAI_API_KEY',
    )
    return { handled: false }
  }

  // Mode gate — checked BEFORE any provider call, not just before the
  // send/draft decision at the end. human_active/paused/closed means a
  // human already owns this conversation (or it's over); the AI must not
  // generate a reply at all, not merely withhold sending one it already
  // wrote. Also serves as the webhook's dispatch gate — the webhook
  // calls runAiAgent unconditionally after Flows/Automations decline the
  // message, and this is what actually decides whether the AI runs.
  const { data: convRow, error: convErr } = await db
    .from('conversations')
    .select('mode')
    .eq('id', input.conversationId)
    .maybeSingle()
  if (convErr) {
    console.error('[ai] conversation mode lookup failed:', convErr.message)
    return { handled: false }
  }
  const mode = (convRow as { mode?: string } | null)?.mode ?? 'ai_active'
  if (mode === 'human_active' || mode === 'paused' || mode === 'closed') {
    return { handled: false }
  }

  // Ensure a session row exists — vars are unused by any Phase 1 tool,
  // but the read/write path is wired now so a later phase (booking) can
  // start storing partial state without a schema change.
  const { data: existingSession } = await db
    .from('ai_sessions')
    .select('conversation_id')
    .eq('conversation_id', input.conversationId)
    .maybeSingle()
  if (!existingSession) {
    await db.from('ai_sessions').insert({
      conversation_id: input.conversationId,
      account_id: input.accountId,
      vars: {},
    })
  }

  const toolCtx: ToolContext = {
    accountId: input.accountId,
    contactId: input.contactId,
    conversationId: input.conversationId,
    config,
  }

  // ------------------------------------------------------------
  // Guardrail — Layer 2: input classification. Runs on the raw inbound
  // text before it's ever sent to a provider. 'high' severity (explicit
  // attempts to extract secrets/config) skips the provider call entirely
  // and hands off to a human; 'medium' severity (known manipulation
  // phrasing) still gets a reply, but with a reinforcement note appended
  // to the system prompt for this turn only. See
  // src/lib/ai/guardrails/input-classifier.ts for the full rationale.
  // ------------------------------------------------------------
  // ------------------------------------------------------------
  // Guardrail — abuse/crisis check. Checked before manipulation
  // classification and unconditionally on severity: a threat or a
  // self-harm crisis message needs an immediate human, full stop, not a
  // graded response. See src/lib/ai/guardrails/input-classifier.ts.
  // ------------------------------------------------------------
  const abuseCheck = classifyAbuse(input.inboundText)
  if (abuseCheck.flagged) {
    await logAuditEvent(db, {
      accountId: input.accountId,
      conversationId: input.conversationId,
      eventType: 'input_abuse_detected',
      severity: 'critical',
      detail: { reasons: abuseCheck.reasons },
    })
    await executeTool(toolCtx, 'assign_to_human', {
      reason: `Abusive or crisis-level input: ${abuseCheck.reasons.join('; ')}`,
    })
    try {
      await sendAiReply({
        accountId: input.accountId,
        userId: input.userId,
        conversationId: input.conversationId,
        contactId: input.contactId,
        text: ABUSE_BOUNDARY_MESSAGE,
      })
    } catch (err) {
      console.error('[ai] send failed after abuse-guardrail block:', err)
    }
    return { handled: true }
  }

  const classification = classifyInboundText(input.inboundText)
  if (classification.severity === 'high') {
    await logAuditEvent(db, {
      accountId: input.accountId,
      conversationId: input.conversationId,
      eventType: 'input_blocked',
      severity: 'critical',
      detail: { reasons: classification.reasons },
    })
    await executeTool(toolCtx, 'assign_to_human', {
      reason: `Suspicious input blocked: ${classification.reasons.join('; ')}`,
    })
    try {
      await sendAiReply({
        accountId: input.accountId,
        userId: input.userId,
        conversationId: input.conversationId,
        contactId: input.contactId,
        text: "I'm connecting you with our team to help with that.",
      })
    } catch (err) {
      console.error('[ai] send failed after input-guardrail block:', err)
    }
    return { handled: true }
  }

  const history = await loadHistory(db, input.conversationId)
  const systemPrompt = buildSystemPrompt(config)
  let systemPromptForTurn = systemPrompt
  if (classification.severity === 'medium') {
    await logAuditEvent(db, {
      accountId: input.accountId,
      conversationId: input.conversationId,
      eventType: 'input_flagged',
      severity: 'warning',
      detail: { reasons: classification.reasons },
    })
    systemPromptForTurn = systemPrompt + INPUT_REINFORCEMENT_NOTE
  }

  const tools = listToolSchemas()

  let winningProvider: LlmProvider | null = null
  let output: GenerateReplyOutput
  try {
    output = await generateWithFallback(providers, async (provider) => {
      const result = await provider.generateReply({
        systemPrompt: systemPromptForTurn,
        history,
        tools,
      })
      winningProvider = provider
      return result
    })
  } catch (err) {
    console.error('[ai] generateReply failed on every configured provider:', err)
    await logAuditEvent(db, {
      accountId: input.accountId,
      conversationId: input.conversationId,
      eventType: 'provider_failed',
      severity: 'warning',
      detail: { stage: 'generateReply', error: err instanceof Error ? err.message : String(err) },
    })
    return { handled: false }
  }

  const toolCallLog: unknown[] = []
  let rounds = 0
  while (output.toolCalls && output.toolCalls.length > 0 && rounds < MAX_TOOL_ROUNDS) {
    rounds += 1
    const priorToolCalls = output.toolCalls
    const toolResults = []
    for (const call of priorToolCalls) {
      let result: ToolResult
      // ------------------------------------------------------------
      // Guardrail — consequential-action gating. When the account has
      // opted into require_approval, a tool that would mutate a CRM
      // record (update_customer, create_lead) is queued into
      // ai_pending_actions instead of executed — a human approves it
      // from the inbox (see POST /api/ai/pending-actions/[id]) before
      // it actually happens. Read-only tools and assign_to_human are
      // never gated. See src/lib/ai/guardrails/consequential.ts.
      //
      // Also force-gated (regardless of the account's own setting) when
      // this turn's input was flagged medium-severity by the input
      // classifier above — a manipulation attempt shouldn't get to
      // silently mutate a CRM record on an 'auto' account even if it
      // fails to talk the model into revealing anything. This is the
      // "restrict tools" response to a suspicious turn, distinct from
      // the harder "skip the model entirely" response to a high-severity
      // one.
      // ------------------------------------------------------------
      const forceGateThisTurn = classification.severity === 'medium'
      if (
        isConsequentialTool(call.name) &&
        (config.consequential_action_mode === 'require_approval' || forceGateThisTurn)
      ) {
        const { error: pendingErr } = await db.from('ai_pending_actions').insert({
          account_id: input.accountId,
          conversation_id: input.conversationId,
          contact_id: input.contactId,
          tool_name: call.name,
          tool_arguments: call.arguments,
          status: 'pending',
        })
        if (pendingErr) console.error('[ai] pending action insert failed:', pendingErr.message)
        await logAuditEvent(db, {
          accountId: input.accountId,
          conversationId: input.conversationId,
          eventType: 'tool_gated',
          severity: 'warning',
          detail: { tool: call.name, arguments: call.arguments },
        })
        result = GATED_TOOL_RESULT
      } else {
        result = await executeTool(toolCtx, call.name, call.arguments)
        await logAuditEvent(db, {
          accountId: input.accountId,
          conversationId: input.conversationId,
          eventType: 'tool_executed',
          severity: 'info',
          detail: { tool: call.name, arguments: call.arguments, result },
        })
      }
      toolResults.push({ toolCallId: call.id, result })
      toolCallLog.push({ name: call.name, arguments: call.arguments, result })
    }
    try {
      // Continue with the SAME provider that generated the tool call —
      // it must reconstruct its own wire-format assistant turn from the
      // normalized call, so switching providers mid-turn isn't sound.
      // If the account only has one provider configured this is also
      // simply the only option.
      output = await winningProvider!.continueWithToolResults({
        systemPrompt: systemPromptForTurn,
        history,
        tools,
        priorToolCalls,
        toolResults,
      })
    } catch (err) {
      console.error('[ai] continueWithToolResults failed:', err)
      await logAuditEvent(db, {
        accountId: input.accountId,
        conversationId: input.conversationId,
        eventType: 'provider_failed',
        severity: 'warning',
        detail: {
          stage: 'continueWithToolResults',
          error: err instanceof Error ? err.message : String(err),
        },
      })
      output = {
        text: "Sorry, I'm having trouble responding right now — connecting you with our team.",
      }
      // Fail safe toward a human rather than leaving the customer with
      // no reply and no path forward.
      await executeTool(toolCtx, 'assign_to_human', {
        reason: 'AI provider error mid-conversation',
      })
      break
    }
  }
  if (rounds >= MAX_TOOL_ROUNDS && output.toolCalls?.length) {
    await logAuditEvent(db, {
      accountId: input.accountId,
      conversationId: input.conversationId,
      eventType: 'tool_loop_exceeded',
      severity: 'warning',
      detail: { rounds },
    })
    output = {
      text: "Sorry, I'm having trouble completing that — connecting you with our team.",
    }
    await executeTool(toolCtx, 'assign_to_human', {
      reason: 'AI tool-call loop exceeded safety cap',
    })
  }

  let replyText = output.text?.trim()
  if (!replyText) {
    return { handled: true }
  }

  // ------------------------------------------------------------
  // Guardrail — Layer 3: output-leak checking. Checked against the base
  // system prompt (not the reinforced one — the reinforcement note
  // itself is never confidential) right before the reply would go out.
  // A blocked reply is swapped for a generic fallback and the
  // conversation is hard-escalated to a human — never sent as-is. See
  // src/lib/ai/guardrails/output-guard.ts.
  // ------------------------------------------------------------
  const leakCheck = checkOutputForLeak(replyText, systemPrompt)
  if (leakCheck.blocked) {
    await logAuditEvent(db, {
      accountId: input.accountId,
      conversationId: input.conversationId,
      eventType: 'output_blocked',
      severity: 'critical',
      detail: { reason: leakCheck.reason },
    })
    replyText = OUTPUT_BLOCKED_FALLBACK_TEXT
    await executeTool(toolCtx, 'assign_to_human', {
      reason: `AI reply blocked by output guardrail: ${leakCheck.reason}`,
    })
  }

  // Reuse the `mode` read at gate time, deliberately not re-queried: if a
  // mid-turn tool call (e.g. the safety-cap fallback above, or the
  // output-guardrail block just above) just flipped the conversation to
  // human_active, the reply already generated for *this* turn —
  // typically a "connecting you with our team" handoff message — should
  // still go out normally rather than get queued as a draft; the
  // human_active mode governs turns from here on.
  if (mode === 'ai_suggestion_only') {
    const { error: draftErr } = await db.from('ai_draft_replies').insert({
      conversation_id: input.conversationId,
      account_id: input.accountId,
      content_text: replyText,
      tool_calls: toolCallLog,
      status: 'pending',
    })
    if (draftErr) console.error('[ai] draft insert failed:', draftErr.message)
    return { handled: true }
  }

  try {
    await sendAiReply({
      accountId: input.accountId,
      userId: input.userId,
      conversationId: input.conversationId,
      contactId: input.contactId,
      text: replyText,
    })
  } catch (err) {
    console.error('[ai] send failed:', err)
  }

  return { handled: true }
}

async function loadHistory(
  db: ReturnType<typeof supabaseAdmin>,
  conversationId: string,
): Promise<ChatMessage[]> {
  const { data, error } = await db
    .from('messages')
    .select('sender_type, content_text')
    .eq('conversation_id', conversationId)
    .order('created_at', { ascending: false })
    .limit(HISTORY_LIMIT)
  if (error) {
    console.error('[ai] history load failed:', error.message)
    return []
  }
  return ((data ?? []) as { sender_type: string; content_text: string | null }[])
    .reverse()
    .filter((m) => m.content_text)
    .map((m) => ({
      role: m.sender_type === 'customer' ? ('user' as const) : ('assistant' as const),
      content: m.content_text as string,
    }))
}
