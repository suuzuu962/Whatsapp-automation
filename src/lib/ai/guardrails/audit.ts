import type { SupabaseClient } from "@supabase/supabase-js";
import type { AiAuditEventType, AiAuditSeverity } from "@/types";

/**
 * Append-only guardrail trail — every input flag/block, output block,
 * tool execution/gating, and pending-action resolution the agent
 * produces. Writes go through the service-role client (agent.ts already
 * holds one via supabaseAdmin()) since there's no user-authored INSERT
 * policy on `ai_audit_log` — see supabase/migrations/028_ai_guardrails.sql.
 *
 * Never throws — an audit-log failure shouldn't break the customer's
 * conversation turn. Logs to the server console instead, same
 * fail-open-on-bookkeeping convention as the rest of agent.ts (e.g. the
 * ai_draft_replies insert-error handling).
 */
export async function logAuditEvent(
  db: SupabaseClient,
  input: {
    accountId: string;
    conversationId: string | null;
    eventType: AiAuditEventType;
    severity?: AiAuditSeverity;
    detail?: Record<string, unknown>;
  },
): Promise<void> {
  const { error } = await db.from("ai_audit_log").insert({
    account_id: input.accountId,
    conversation_id: input.conversationId,
    event_type: input.eventType,
    severity: input.severity ?? "info",
    detail: input.detail ?? {},
  });
  if (error) {
    console.error("[ai] audit log insert failed:", error.message);
  }
}
