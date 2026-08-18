-- ============================================================
-- AI Agent core (Phase 1).
--
-- What this migration adds:
--
--   1. `ai_agent_config` — one row per account (mirrors whatsapp_config's
--      one-per-account shape). Structured business configuration the AI
--      reply engine reads on every turn — persona, services, hours, FAQs,
--      escalation rules, default pipeline/stage for AI-created leads, and
--      the provider fallback order. `generated_system_prompt` is a cache:
--      regenerated server-side whenever the structured fields are saved,
--      never hand-edited by the business owner directly (the wizard edits
--      the structured fields; the prompt is derived, not authored).
--
--   2. `ai_sessions` — one row per conversation. Working memory for the
--      tool-calling loop (partial booking fields, last-known intent,
--      anything that needs to survive between turns). Same role as
--      `flow_runs.vars`, but scoped to a conversation rather than a fixed
--      node-graph run, since AI conversations are open-ended.
--
--   3. `ai_draft_replies` — Copilot-mode support. When a conversation is
--      in `ai_suggestion_only` mode, the agent writes its proposed reply
--      here instead of sending it; an agent approves/edits/rejects from
--      the inbox.
--
--   4. `conversations.mode` — additive column, NOT a replacement for the
--      existing `status` (open/pending/closed) CHECK. Governs whether the
--      AI is allowed to reply at all: ai_active | human_active |
--      ai_suggestion_only | paused | closed. Defaults to 'ai_active' but
--      is inert for any account without ai_agent_config.enabled = true.
--
-- Idempotent — safe to run multiple times.
-- ============================================================

-- ============================================================
-- 1. ai_agent_config
-- ============================================================
CREATE TABLE IF NOT EXISTS ai_agent_config (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  enabled BOOLEAN NOT NULL DEFAULT FALSE,

  -- Structured configuration — edited via the setup wizard, never as raw
  -- prompt text. See src/lib/ai/prompt.ts for how these compile into
  -- `generated_system_prompt`.
  business_profile JSONB NOT NULL DEFAULT '{}'::jsonb,   -- { name, type, description }
  agent_persona JSONB NOT NULL DEFAULT '{}'::jsonb,      -- { name, tone, languages }
  services JSONB NOT NULL DEFAULT '[]'::jsonb,           -- [{ name, price, description }]
  business_hours JSONB NOT NULL DEFAULT '{}'::jsonb,     -- { timezone, windows: [...] }
  faqs JSONB NOT NULL DEFAULT '[]'::jsonb,                -- [{ question, answer }]
  escalation_rules JSONB NOT NULL DEFAULT '[]'::jsonb,    -- free-text rules the agent checks
  restricted_topics TEXT[] NOT NULL DEFAULT '{}',

  -- Defaults so `create_lead` never needs CRM internals from the model.
  default_pipeline_id UUID REFERENCES pipelines(id) ON DELETE SET NULL,
  default_stage_id UUID REFERENCES pipeline_stages(id) ON DELETE SET NULL,

  -- Provider fallback order, e.g. ['anthropic','openai']. Empty means the
  -- engine picks whichever configured provider comes first in its own
  -- built-in default order.
  provider_priority TEXT[] NOT NULL DEFAULT '{}',

  -- Cached, regenerated on every save. Never null once enabled=true (the
  -- save path always regenerates it); nullable at the type level only
  -- because a freshly-inserted disabled row may not have one yet.
  generated_system_prompt TEXT,

  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  UNIQUE (account_id)
);

CREATE INDEX IF NOT EXISTS idx_ai_agent_config_account
  ON ai_agent_config(account_id);

ALTER TABLE ai_agent_config ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS ai_agent_config_select ON ai_agent_config;
CREATE POLICY ai_agent_config_select ON ai_agent_config FOR SELECT
  USING (is_account_member(account_id));

DROP POLICY IF EXISTS ai_agent_config_insert ON ai_agent_config;
CREATE POLICY ai_agent_config_insert ON ai_agent_config FOR INSERT
  WITH CHECK (is_account_member(account_id, 'admin'));

DROP POLICY IF EXISTS ai_agent_config_update ON ai_agent_config;
CREATE POLICY ai_agent_config_update ON ai_agent_config FOR UPDATE
  USING (is_account_member(account_id, 'admin'));

DROP POLICY IF EXISTS ai_agent_config_delete ON ai_agent_config;
CREATE POLICY ai_agent_config_delete ON ai_agent_config FOR DELETE
  USING (is_account_member(account_id, 'admin'));

DROP TRIGGER IF EXISTS set_updated_at ON ai_agent_config;
CREATE TRIGGER set_updated_at BEFORE UPDATE ON ai_agent_config
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- ============================================================
-- 2. ai_sessions
-- ============================================================
CREATE TABLE IF NOT EXISTS ai_sessions (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  conversation_id UUID NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  -- Denormalized for RLS/lookup convenience — matches the parent
  -- conversation's account_id, set once at insert time.
  account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  vars JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  UNIQUE (conversation_id)
);

CREATE INDEX IF NOT EXISTS idx_ai_sessions_account
  ON ai_sessions(account_id);

ALTER TABLE ai_sessions ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS ai_sessions_select ON ai_sessions;
CREATE POLICY ai_sessions_select ON ai_sessions FOR SELECT
  USING (is_account_member(account_id));

-- The agent engine writes via the service-role client (bypasses RLS, same
-- as flow_runs). No INSERT/UPDATE/DELETE policy for regular users — keeps
-- the surface tight, mirrors flow_runs' "runner writes, users only read".

DROP TRIGGER IF EXISTS set_updated_at ON ai_sessions;
CREATE TRIGGER set_updated_at BEFORE UPDATE ON ai_sessions
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- ============================================================
-- 3. ai_draft_replies
-- ============================================================
CREATE TABLE IF NOT EXISTS ai_draft_replies (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  conversation_id UUID NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  content_text TEXT NOT NULL,
  -- Snapshot of any tool calls the draft's generation involved, for the
  -- reviewing agent's context — not re-executed on approval, only the
  -- text is sent.
  tool_calls JSONB NOT NULL DEFAULT '[]'::jsonb,
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'approved', 'rejected', 'sent')),
  -- No FK — mirrors conversations.assigned_agent_id, which is also a bare
  -- UUID with no REFERENCES clause.
  reviewed_by UUID,
  reviewed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_ai_draft_replies_conversation_pending
  ON ai_draft_replies(conversation_id)
  WHERE status = 'pending';

ALTER TABLE ai_draft_replies ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS ai_draft_replies_select ON ai_draft_replies;
CREATE POLICY ai_draft_replies_select ON ai_draft_replies FOR SELECT
  USING (is_account_member(account_id));

DROP POLICY IF EXISTS ai_draft_replies_update ON ai_draft_replies;
CREATE POLICY ai_draft_replies_update ON ai_draft_replies FOR UPDATE
  USING (is_account_member(account_id, 'agent'));

-- INSERT is service-role only (the agent engine writes drafts) — no
-- policy needed for that path; regular users never create drafts
-- directly, only approve/reject/edit existing ones.

-- ============================================================
-- 4. conversations.mode
-- ============================================================
ALTER TABLE conversations
  ADD COLUMN IF NOT EXISTS mode TEXT NOT NULL DEFAULT 'ai_active'
  CHECK (mode IN ('ai_active', 'human_active', 'ai_suggestion_only', 'paused', 'closed'));

CREATE INDEX IF NOT EXISTS idx_conversations_mode
  ON conversations(account_id, mode);
