-- ============================================================
-- AI Agent booking (Phase 3).
--
-- What this migration adds:
--
--   1. `appointments` — this CRM had no slot-based scheduling concept at
--      all before this migration (deals/pipelines exist, but nothing
--      time-bound). One row per booking. `created_by` distinguishes an
--      AI-made booking from one a human agent entered directly in the
--      CRM. Availability/conflict logic lives in
--      src/lib/ai/booking/availability.ts, not in SQL — this table is
--      just the record of what got booked.
--
--   2. `ai_agent_config.default_appointment_duration_minutes` — fallback
--      duration when a service in `services` jsonb doesn't specify its
--      own `duration_minutes`. `business_hours` (added back in
--      027_ai_agent.sql) already carries the per-day windows + timezone
--      this feature reads; no schema change needed there, just a UI to
--      edit it (see the settings wizard) and code that finally reads it.
--
-- Idempotent — safe to run multiple times.
-- ============================================================

-- ============================================================
-- 1. appointments
-- ============================================================
CREATE TABLE IF NOT EXISTS appointments (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  contact_id UUID NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
  -- Which conversation created it, if any — nullable since a human agent
  -- can also create a booking directly in the CRM with no conversation.
  conversation_id UUID REFERENCES conversations(id) ON DELETE SET NULL,
  service TEXT NOT NULL,
  starts_at TIMESTAMPTZ NOT NULL,
  ends_at TIMESTAMPTZ NOT NULL,
  status TEXT NOT NULL DEFAULT 'booked'
    CHECK (status IN ('booked', 'cancelled', 'completed', 'no_show')),
  notes TEXT,
  created_by TEXT NOT NULL DEFAULT 'ai' CHECK (created_by IN ('ai', 'human')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  CHECK (ends_at > starts_at)
);

CREATE INDEX IF NOT EXISTS idx_appointments_account_starts
  ON appointments(account_id, starts_at);

-- Powers list_upcoming_bookings (src/lib/ai/tools.ts) — a contact's
-- future booked appointments, which is the only lookup pattern that
-- tool needs.
CREATE INDEX IF NOT EXISTS idx_appointments_contact_booked
  ON appointments(contact_id, starts_at)
  WHERE status = 'booked';

ALTER TABLE appointments ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS appointments_select ON appointments;
CREATE POLICY appointments_select ON appointments FOR SELECT
  USING (is_account_member(account_id));

DROP POLICY IF EXISTS appointments_insert ON appointments;
CREATE POLICY appointments_insert ON appointments FOR INSERT
  WITH CHECK (is_account_member(account_id, 'agent'));

DROP POLICY IF EXISTS appointments_update ON appointments;
CREATE POLICY appointments_update ON appointments FOR UPDATE
  USING (is_account_member(account_id, 'agent'));

-- No DELETE policy — cancel is a status update (status='cancelled'),
-- never a row delete, same convention as everything else in this schema
-- that needs an audit trail (deals, conversations).

DROP TRIGGER IF EXISTS set_updated_at ON appointments;
CREATE TRIGGER set_updated_at BEFORE UPDATE ON appointments
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- ============================================================
-- 2. ai_agent_config.default_appointment_duration_minutes
-- ============================================================
ALTER TABLE ai_agent_config
  ADD COLUMN IF NOT EXISTS default_appointment_duration_minutes INTEGER NOT NULL DEFAULT 30
  CHECK (default_appointment_duration_minutes > 0);
