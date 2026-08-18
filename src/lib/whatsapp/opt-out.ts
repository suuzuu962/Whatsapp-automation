import { supabaseAdmin } from "@/lib/ai/admin-client";
import { sendTextMessage } from "./meta-api";
import { decrypt } from "./encryption";
import {
  sanitizePhoneForMeta,
  isValidE164,
  phoneVariants,
  isRecipientNotAllowedError,
} from "./phone-utils";

/**
 * WhatsApp opt-out keyword detection + the shared enforcement check
 * every outbound send path uses. See supabase/migrations/030_opt_out.sql
 * for the schema, and the module docstring there for the full list of
 * gated send paths.
 *
 * Matching is on the WHOLE message (after trimming/lowercasing/
 * stripping punctuation), not a substring search — "please don't stop
 * texting me" must never opt someone out. This is the same
 * whole-message-match convention SMS/WhatsApp compliance keyword
 * handling generally uses.
 */

export class ContactOptedOutError extends Error {
  constructor(message = "This contact has opted out of WhatsApp messages") {
    super(message);
    this.name = "ContactOptedOutError";
  }
}

const STRIP_PUNCT_RE = /[^\w\s]/g;

function normalize(text: string): string {
  return text.trim().toLowerCase().replace(STRIP_PUNCT_RE, "").replace(/\s+/g, " ").trim();
}

const OPT_OUT_PHRASES = new Set([
  "stop",
  "unsubscribe",
  "cancel",
  "optout",
  "opt out",
  "quit",
  "end",
  "remove me",
]);

const OPT_IN_PHRASES = new Set(["start", "subscribe", "optin", "opt in", "unstop"]);

export function isOptOutMessage(text: string): boolean {
  return OPT_OUT_PHRASES.has(normalize(text));
}

export function isOptInMessage(text: string): boolean {
  return OPT_IN_PHRASES.has(normalize(text));
}

/** Throws ContactOptedOutError if the row (already loaded by the
 *  caller's own account-scoped query) carries an opted_out_at. Every
 *  send-path module already selects the contact row for phone lookup —
 *  this just checks a field on it rather than adding a second query. */
export function assertNotOptedOut(contact: { opted_out_at?: string | null }): void {
  if (contact.opted_out_at) {
    throw new ContactOptedOutError();
  }
}

/**
 * Sends the one-time STOP/START compliance confirmation, bypassing
 * `assertNotOptedOut` entirely — this IS the transactional exception
 * every opt-out convention carves out (a business must always be able
 * to confirm the opt-out/opt-in itself). Never call this for anything
 * other than that confirmation. Swallows its own errors (logs instead)
 * since it's invoked from the webhook's synchronous inbound-processing
 * path, where a delivery failure here must not break message ingestion.
 */
export async function sendOptStatusConfirmation(params: {
  accountId: string;
  conversationId: string;
  contactPhone: string;
  text: string;
}): Promise<void> {
  try {
    const db = supabaseAdmin();
    const sanitized = sanitizePhoneForMeta(params.contactPhone);
    if (!isValidE164(sanitized)) return;

    const { data: config } = await db
      .from("whatsapp_config")
      .select("*")
      .eq("account_id", params.accountId)
      .maybeSingle();
    if (!config) return;

    const accessToken = decrypt(config.access_token);
    let waMessageId = "";
    for (const variant of phoneVariants(sanitized)) {
      try {
        const r = await sendTextMessage({
          phoneNumberId: config.phone_number_id,
          accessToken,
          to: variant,
          text: params.text,
        });
        waMessageId = r.messageId;
        break;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (!isRecipientNotAllowedError(msg)) throw err;
      }
    }
    if (!waMessageId) return;

    await db.from("messages").insert({
      conversation_id: params.conversationId,
      sender_type: "bot",
      content_type: "text",
      content_text: params.text,
      message_id: waMessageId,
      status: "sent",
    });
    await db
      .from("conversations")
      .update({
        last_message_text: params.text,
        last_message_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      })
      .eq("id", params.conversationId);
  } catch (err) {
    console.error("[opt-out] compliance confirmation send failed:", err);
  }
}
