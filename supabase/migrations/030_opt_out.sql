-- ============================================================
-- WhatsApp opt-out enforcement.
--
-- `contacts.opted_out_at` — set when the contact replies with a
-- STOP-style keyword (see src/lib/whatsapp/opt-out.ts), cleared when
-- they reply START-style. Every outbound WhatsApp send path
-- (src/lib/whatsapp/ai-send.ts, src/lib/automations/meta-send.ts,
-- src/lib/flows/meta-send.ts, the manual send route, and the broadcast
-- route) refuses to message a contact with this set — see
-- assertNotOptedOut in opt-out.ts.
--
-- Idempotent — safe to run multiple times.
-- ============================================================

ALTER TABLE contacts
  ADD COLUMN IF NOT EXISTS opted_out_at TIMESTAMPTZ;

-- Partial index — only opted-out contacts are ever queried by this
-- column (broadcast recipient filtering), so a full index would be
-- pure overhead for the common case.
CREATE INDEX IF NOT EXISTS idx_contacts_opted_out
  ON contacts(account_id)
  WHERE opted_out_at IS NOT NULL;
