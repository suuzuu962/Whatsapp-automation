-- ============================================================
-- Appointment reminders.
--
-- `ai_agent_config.appointment_reminder_offsets_minutes` — how long
-- before an appointment a reminder should go out, e.g. '{1440,120}'
-- (24 hours and 2 hours). Empty array disables reminders for the
-- account.
--
-- `appointment_reminders` — one row per (appointment, offset) actually
-- sent. The UNIQUE constraint is the idempotency guard: the cron route
-- (src/app/api/ai/booking-reminders/cron/route.ts) inserts a claim row
-- BEFORE sending — if two overlapping cron ticks race for the same
-- appointment+offset, only one insert succeeds, so only one message
-- goes out.
--
-- Idempotent — safe to run multiple times.
-- ============================================================

ALTER TABLE ai_agent_config
  ADD COLUMN IF NOT EXISTS appointment_reminder_offsets_minutes INTEGER[] NOT NULL DEFAULT '{1440,120}';

CREATE TABLE IF NOT EXISTS appointment_reminders (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  appointment_id UUID NOT NULL REFERENCES appointments(id) ON DELETE CASCADE,
  account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  offset_minutes INTEGER NOT NULL,
  sent_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  UNIQUE (appointment_id, offset_minutes)
);

CREATE INDEX IF NOT EXISTS idx_appointment_reminders_appointment
  ON appointment_reminders(appointment_id);

ALTER TABLE appointment_reminders ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS appointment_reminders_select ON appointment_reminders;
CREATE POLICY appointment_reminders_select ON appointment_reminders FOR SELECT
  USING (is_account_member(account_id));

-- INSERT is service-role only (the cron route claims + writes) — no
-- policy needed; this table is a machine-written send log, never
-- user-authored.
