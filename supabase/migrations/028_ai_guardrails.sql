-- ============================================================
-- AI Agent guardrails (Phase 2).
--
-- What this migration adds:
--
--   1. `ai_agent_config.consequential_action_mode` — per-account toggle.
--      'auto' (default) lets the agent execute update_customer/create_lead
--      immediately, same as Phase 1. 'require_approval' makes the agent
--      queue those two tool calls into `ai_pending_actions` instead of
--      executing them — a human must approve before the CRM record
--      actually changes. Read-only tools (get_customer_details,
--      search_business_knowledge) and assign_to_human are never gated —
--      gating only applies to tools that mutate a CRM record on the
--      model's say-so. See src/lib/ai/guardrails/consequential.ts.
--
--   2. `ai_pending_actions` — one row per gated tool call awaiting human
--      review. Mirrors `ai_draft_replies`'s shape (pending/approved/
--      rejected), but for a tool call rather than a reply's text.
--      Approving actually executes the tool (see
--      POST /api/ai/pending-actions/[id]); rejecting just discards it.
--
--   3. `ai_audit_log` — append-only trail of every guardrail-relevant
--      event: flagged/blocked input, blocked output, tool executions,
--      gated actions, and their resolutions. Same append-only role as
--      `flow_run_events`, but for the AI engine. Admin-only read — this
--      table can contain the substance of what customers said and what
--      the agent did with it, which is the same sensitivity level as the
--      conversation itself.
--
-- Idempotent — safe to run multiple times.
-- ============================================================

-- ============================================================
-- 1. ai_agent_config.consequential_action_mode
-- ============================================================
ALTER TABLE ai_agent_config
  ADD COLUMN IF NOT EXISTS consequential_action_mode TEXT NOT NULL DEFAULT 'auto'
  CHECK (consequential_action_mode IN ('auto', 'require_approval'));

-- ============================================================
-- 2. ai_pending_actions
-- ============================================================
CREATE TABLE IF NOT EXISTS ai_pending_actions (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  conversation_id UUID NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  contact_id UUID NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
  tool_name TEXT NOT NULL,
  tool_arguments JSONB NOT NULL DEFAULT '{}'::jsonb,
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'approved', 'rejected')),
  -- Populated once approved and executed — the tool executor's result,
  -- for the reviewing agent's record.
  result JSONB,
  reviewed_by UUID,
  reviewed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_ai_pending_actions_conversation_pending
  ON ai_pending_actions(conversation_id)
  WHERE status = 'pending';

ALTER TABLE ai_pending_actions ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS ai_pending_actions_select ON ai_pending_actions;
CREATE POLICY ai_pending_actions_select ON ai_pending_actions FOR SELECT
  USING (is_account_member(account_id));

DROP POLICY IF EXISTS ai_pending_actions_update ON ai_pending_actions;
CREATE POLICY ai_pending_actions_update ON ai_pending_actions FOR UPDATE
  USING (is_account_member(account_id, 'agent'));

-- INSERT is service-role only (the agent engine queues actions) — no
-- policy needed; regular users only approve/reject existing rows.

-- ============================================================
-- 3. ai_audit_log
-- ============================================================
CREATE TABLE IF NOT EXISTS ai_audit_log (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  conversation_id UUID REFERENCES conversations(id) ON DELETE SET NULL,
  event_type TEXT NOT NULL CHECK (event_type IN (
    'input_flagged',
    'input_blocked',
    'output_blocked',
    'tool_executed',
    'tool_gated',
    'tool_loop_exceeded',
    'provider_failed',
    'action_approved',
    'action_rejected'
  )),
  severity TEXT NOT NULL DEFAULT 'info' CHECK (severity IN ('info', 'warning', 'critical')),
  detail JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_ai_audit_log_account_created
  ON ai_audit_log(account_id, created_at DESC);

ALTER TABLE ai_audit_log ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS ai_audit_log_select ON ai_audit_log;
CREATE POLICY ai_audit_log_select ON ai_audit_log FOR SELECT
  USING (is_account_member(account_id, 'admin'));

-- INSERT is service-role only (the agent engine writes every event) — no
-- policy needed; this table is a machine-written trail, never
-- user-authored.
