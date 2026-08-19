import { supabaseAdmin } from '@/lib/flows/admin-client'
import { findExistingContact, isUniqueViolation } from '@/lib/contacts/dedupe'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type ContactRow = any

export interface ContactOutcome {
  contact: ContactRow
  /** True when this call created the row; drives new_contact_created
   *  automation dispatch in the webhook's processMessage. */
  wasCreated: boolean
}

/**
 * Find an existing contact for `phone` in `accountId`, or create one.
 * Shared by the inbound webhook and any operator-initiated send (e.g.
 * starting a new conversation), so both paths agree on what "same
 * number" means (see src/lib/contacts/dedupe.ts, issue #212).
 */
export async function findOrCreateContact(
  accountId: string,
  attributedUserId: string,
  phone: string,
  name: string
): Promise<ContactOutcome | null> {
  // Find an existing contact for this account by phone. The shared
  // helper pre-filters in SQL by the last-8-digit suffix (so we don't
  // pull every contact on every inbound message) then applies the
  // strict `phonesMatch` in JS on the small candidate set. The same
  // helper backs the manual contact form and CSV import, so all paths
  // agree on what "same number" means (issue #212).
  const existingContact = await findExistingContact(
    supabaseAdmin(),
    accountId,
    phone,
  )

  if (existingContact) {
    // Update name if it changed
    if (name && name !== existingContact.name) {
      await supabaseAdmin()
        .from('contacts')
        .update({ name, updated_at: new Date().toISOString() })
        .eq('id', existingContact.id)
    }
    return { contact: existingContact, wasCreated: false }
  }

  // Create new contact. account_id is the tenancy column;
  // user_id is the NOT NULL FK audit column (attributed to whoever
  // is responsible for this contact existing — the WhatsApp config
  // owner for inbound messages, or the operator for a manually
  // started conversation).
  const { data: newContact, error: createError } = await supabaseAdmin()
    .from('contacts')
    .insert({
      account_id: accountId,
      user_id: attributedUserId,
      phone,
      name: name || phone,
    })
    .select()
    .single()

  if (createError) {
    // Lost a race: a concurrent insert (inbound delivery or another
    // operator) created this contact between our lookup and insert,
    // and the unique index (migration 022) rejected the duplicate.
    // Re-resolve the existing row instead of failing outright.
    if (isUniqueViolation(createError)) {
      const raced = await findExistingContact(supabaseAdmin(), accountId, phone)
      if (raced) return { contact: raced, wasCreated: false }
    }
    console.error('Error creating contact:', createError)
    return null
  }

  return { contact: newContact, wasCreated: true }
}

/**
 * Find the existing conversation for `contactId` in `accountId`, or
 * create one. Idempotent — safe to call even when a conversation
 * already exists (e.g. an operator picking a contact that already has
 * one, even if it has no messages yet).
 */
export async function findOrCreateConversation(
  accountId: string,
  attributedUserId: string,
  contactId: string,
) {
  // Look for existing conversation in this account
  const { data: existing, error: findError } = await supabaseAdmin()
    .from('conversations')
    .select('*')
    .eq('account_id', accountId)
    .eq('contact_id', contactId)
    .single()

  if (!findError && existing) {
    return existing
  }

  // Create new conversation. Same tenancy + audit split as
  // findOrCreateContact above.
  const { data: newConv, error: createError } = await supabaseAdmin()
    .from('conversations')
    .insert({
      account_id: accountId,
      user_id: attributedUserId,
      contact_id: contactId,
    })
    .select()
    .single()

  if (createError) {
    console.error('Error creating conversation:', createError)
    return null
  }

  return newConv
}
