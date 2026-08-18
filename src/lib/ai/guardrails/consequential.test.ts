import { describe, it, expect } from "vitest";
import { isConsequentialTool, CONSEQUENTIAL_TOOLS } from "./consequential";

describe("isConsequentialTool", () => {
  it("gates the tools that mutate a CRM record or have an irreversible external effect", () => {
    expect(isConsequentialTool("update_customer")).toBe(true);
    expect(isConsequentialTool("create_lead")).toBe(true);
    expect(isConsequentialTool("create_booking")).toBe(true);
    expect(isConsequentialTool("reschedule_booking")).toBe(true);
    expect(isConsequentialTool("cancel_booking")).toBe(true);
    expect(isConsequentialTool("send_email")).toBe(true);
  });

  it("never gates read-only tools or the human-handoff safety valve", () => {
    expect(isConsequentialTool("get_customer_details")).toBe(false);
    expect(isConsequentialTool("search_business_knowledge")).toBe(false);
    expect(isConsequentialTool("check_availability")).toBe(false);
    expect(isConsequentialTool("list_upcoming_bookings")).toBe(false);
    expect(isConsequentialTool("assign_to_human")).toBe(false);
  });

  it("does not gate an unknown/hallucinated tool name", () => {
    expect(isConsequentialTool("delete_everything")).toBe(false);
  });

  it("exposes exactly the six consequential tools", () => {
    expect([...CONSEQUENTIAL_TOOLS].sort()).toEqual([
      "cancel_booking",
      "create_booking",
      "create_lead",
      "reschedule_booking",
      "send_email",
      "update_customer",
    ]);
  });
});
