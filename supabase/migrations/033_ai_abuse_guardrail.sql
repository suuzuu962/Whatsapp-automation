-- ============================================================
-- Abuse/crisis input guardrail — new ai_audit_log event type.
--
-- The input classifier (src/lib/ai/guardrails/input-classifier.ts) gets
-- a second, independent classification axis alongside the existing
-- manipulation-attempt severity: classifyAbuse() flags threats of
-- violence and self-harm/crisis language, distinct from a prompt-
-- injection attempt. agent.ts logs a hit as 'input_abuse_detected' —
-- add it to the CHECK constraint so that write doesn't fail.
--
-- Idempotent — safe to re-run.
-- ============================================================

ALTER TABLE ai_audit_log
  DROP CONSTRAINT IF EXISTS ai_audit_log_event_type_check;

ALTER TABLE ai_audit_log
  ADD CONSTRAINT ai_audit_log_event_type_check
  CHECK (event_type IN (
    'input_flagged',
    'input_blocked',
    'input_abuse_detected',
    'output_blocked',
    'tool_executed',
    'tool_gated',
    'tool_loop_exceeded',
    'provider_failed',
    'action_approved',
    'action_rejected'
  ));
