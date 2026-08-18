/**
 * Consequential-action gating. Only tools that mutate a CRM record on
 * the model's own judgment are gated — read-only tools
 * (get_customer_details, search_business_knowledge, check_availability,
 * list_upcoming_bookings) never need approval since they can't change
 * anything, and assign_to_human is itself the safety valve, not
 * something to gate behind another one.
 *
 * create_booking/reschedule_booking/cancel_booking (Phase 3) are gated
 * on the same footing as update_customer/create_lead — all five change
 * a real record on the model's own judgment call, so they share one
 * approval setting rather than needing a separate booking-specific
 * toggle. send_email is gated too — an email is an irreversible
 * external side effect, the same tier of consequence as creating a
 * lead, even though it doesn't touch this CRM's own tables.
 *
 * When `ai_agent_config.consequential_action_mode === 'require_approval'`,
 * agent.ts checks `isConsequentialTool(call.name)` before executing a
 * tool call from the loop; if true, it queues the call into
 * `ai_pending_actions` instead of running it — see runAiAgent in
 * ../agent.ts.
 */

export const CONSEQUENTIAL_TOOLS: ReadonlySet<string> = new Set([
  "update_customer",
  "create_lead",
  "create_booking",
  "reschedule_booking",
  "cancel_booking",
  "send_email",
]);

export function isConsequentialTool(name: string): boolean {
  return CONSEQUENTIAL_TOOLS.has(name);
}

/**
 * Synthetic tool result fed back to the model in place of the real
 * execution result when a call is gated — lets the model tell the
 * customer their request is being processed without claiming the action
 * already happened.
 */
export const GATED_TOOL_RESULT = {
  gated: true,
  note: "This action needs approval from a team member before it takes effect. Let the customer know their request is being processed.",
} as const;
