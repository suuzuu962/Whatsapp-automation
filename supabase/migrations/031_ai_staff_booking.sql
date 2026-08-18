-- ============================================================
-- Named staff / multi-resource booking.
--
-- What this migration adds:
--
--   1. `staff_members` — one row per bookable staff member. Each has
--      its own `working_hours` (same {day, open, close} window shape
--      as `ai_agent_config.business_hours.windows` — see
--      027_ai_agent.sql). An EMPTY `working_hours` array means "inherit
--      the account's business hours" rather than requiring every staff
--      row to duplicate them — the common case for a business where
--      everyone works the same hours. Staff share the account's
--      configured timezone (ai_agent_config.business_hours.timezone);
--      there is no per-staff timezone, since staff at one business are
--      assumed to be in the same one.
--
--   2. `appointments.staff_id` — nullable. NULL means "no specific
--      staff" (the pre-this-migration behavior: one shared account-wide
--      calendar, still fully supported for accounts that never add any
--      staff). Once an account has active staff rows, the booking tools
--      (src/lib/ai/tools.ts) auto-assign an available one, or honor an
--      explicit customer request, and stamp `staff_id` accordingly.
--
-- Idempotent — safe to run multiple times.
-- ============================================================

CREATE TABLE IF NOT EXISTS staff_members (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  active BOOLEAN NOT NULL DEFAULT TRUE,
  working_hours JSONB NOT NULL DEFAULT '[]'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_staff_members_account
  ON staff_members(account_id);

ALTER TABLE staff_members ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS staff_members_select ON staff_members;
CREATE POLICY staff_members_select ON staff_members FOR SELECT
  USING (is_account_member(account_id));

DROP POLICY IF EXISTS staff_members_insert ON staff_members;
CREATE POLICY staff_members_insert ON staff_members FOR INSERT
  WITH CHECK (is_account_member(account_id, 'admin'));

DROP POLICY IF EXISTS staff_members_update ON staff_members;
CREATE POLICY staff_members_update ON staff_members FOR UPDATE
  USING (is_account_member(account_id, 'admin'));

DROP POLICY IF EXISTS staff_members_delete ON staff_members;
CREATE POLICY staff_members_delete ON staff_members FOR DELETE
  USING (is_account_member(account_id, 'admin'));

DROP TRIGGER IF EXISTS set_updated_at ON staff_members;
CREATE TRIGGER set_updated_at BEFORE UPDATE ON staff_members
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

ALTER TABLE appointments
  ADD COLUMN IF NOT EXISTS staff_id UUID REFERENCES staff_members(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_appointments_staff_booked
  ON appointments(staff_id, starts_at)
  WHERE status = 'booked';
