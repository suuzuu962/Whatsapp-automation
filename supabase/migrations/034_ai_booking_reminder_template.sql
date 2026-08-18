-- ============================================================
-- Appointment reminders — send via an approved WhatsApp template.
--
-- 032_ai_booking_reminders.sql shipped reminders as free-form text
-- (sendTextMessage) unconditionally. That only works within Meta's
-- 24-hour customer service window — a proactive "your appointment is
-- tomorrow at 3pm" reminder is exactly the case that's usually outside
-- it (see Twilio's WhatsApp scheduling docs on template validation
-- failures at send time, and Meta's own re-engagement-message
-- rejection, error 131047). Reminders need the same
-- approved-template requirement broadcasts already have
-- (message_templates, status = 'Approved').
--
-- `reminder_template_name`/`reminder_template_language` — which
-- approved template to use. NULL keeps the pre-existing free-text
-- behavior (fine for accounts whose reminder offset is short enough to
-- usually land inside a live session, but not guaranteed) — this is an
-- opt-in upgrade, not a breaking change to accounts already using
-- reminders.
--
-- Idempotent — safe to re-run.
-- ============================================================

ALTER TABLE ai_agent_config
  ADD COLUMN IF NOT EXISTS reminder_template_name TEXT;

ALTER TABLE ai_agent_config
  ADD COLUMN IF NOT EXISTS reminder_template_language TEXT NOT NULL DEFAULT 'en_US';
