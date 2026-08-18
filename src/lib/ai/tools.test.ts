import { describe, it, expect, beforeEach, vi } from "vitest";

// Same hand-rolled query-builder mock shape as automations/engine.test.ts —
// tracks every filter applied so tests can assert hard-scoping (a query
// must always carry an account_id filter matching the trusted context,
// never anything the "model" tried to slip in).
const h = vi.hoisted(() => ({
  state: {
    contact: null as Record<string, unknown> | null,
    account: null as Record<string, unknown> | null,
    appointments: [] as Record<string, unknown>[],
    staffMembers: [] as Record<string, unknown>[],
    updateCalls: [] as { table: string; payload: unknown; filters: [string, string, unknown][] }[],
    insertCalls: [] as { table: string; payload: unknown }[],
  },
}));

vi.mock("./admin-client", () => {
  const { state } = h;

  function matchesFilters(row: Record<string, unknown>, filters: [string, string, unknown][]) {
    return filters.every(([op, k, v]) => {
      const rowVal = row[k];
      switch (op) {
        case "eq":
          return rowVal === v;
        case "neq":
          return rowVal !== v;
        case "gte":
          return String(rowVal) >= String(v);
        case "gt":
          return String(rowVal) > String(v);
        case "lt":
          return String(rowVal) < String(v);
        case "lte":
          return String(rowVal) <= String(v);
        case "in":
          return Array.isArray(v) && v.includes(rowVal);
        default:
          return true;
      }
    });
  }

  function resolve(
    ops: {
      table: string;
      type: string;
      payload?: unknown;
      filters: [string, string, unknown][];
      columns?: string;
    },
    single: boolean,
  ) {
    const { table, type, filters } = ops;
    if (table === "contacts") {
      if (type === "update") {
        state.updateCalls.push({ table, payload: ops.payload, filters });
        return { data: null, error: null };
      }
      // Simulate real account scoping: only return the row if every eq()
      // filter the tool applied actually matches the stored contact.
      const matches = filters.every(([, k, v]) => state.contact?.[k] === v);
      if (!matches || !state.contact) return { data: null, error: null };
      // Project columns like real Supabase's .select('a, b, c') would,
      // so a test asserting the exact returned shape stays honest about
      // what the code actually requested.
      const cols = (ops.columns ?? "*").split(",").map((c) => c.trim());
      const projected =
        cols[0] === "*"
          ? state.contact
          : Object.fromEntries(cols.map((c) => [c, state.contact?.[c] ?? null]));
      return { data: projected, error: null };
    }
    if (table === "accounts") {
      return { data: state.account, error: null };
    }
    if (table === "deals") {
      state.insertCalls.push({ table, payload: ops.payload });
      return { data: null, error: null };
    }
    if (table === "conversations") {
      state.updateCalls.push({ table, payload: ops.payload, filters });
      return { data: null, error: null };
    }
    if (table === "appointments") {
      if (type === "insert") {
        state.insertCalls.push({ table, payload: ops.payload });
        return { data: null, error: null };
      }
      if (type === "update") {
        state.updateCalls.push({ table, payload: ops.payload, filters });
        return { data: null, error: null };
      }
      const matches = state.appointments.filter((row) => matchesFilters(row, filters));
      const cols = (ops.columns ?? "*").split(",").map((c) => c.trim());
      const project = (row: Record<string, unknown>) =>
        cols[0] === "*" ? row : Object.fromEntries(cols.map((c) => [c, row[c] ?? null]));
      const projected = matches.map(project);
      return single ? { data: projected[0] ?? null, error: null } : { data: projected, error: null };
    }
    if (table === "staff_members") {
      const matches = state.staffMembers.filter((row) => matchesFilters(row, filters));
      const cols = (ops.columns ?? "*").split(",").map((c) => c.trim());
      const project = (row: Record<string, unknown>) =>
        cols[0] === "*" ? row : Object.fromEntries(cols.map((c) => [c, row[c] ?? null]));
      const projected = matches.map(project);
      return single ? { data: projected[0] ?? null, error: null } : { data: projected, error: null };
    }
    return { data: null, error: null };
  }

  function builder(table: string) {
    const ops = {
      table,
      type: "select",
      payload: undefined as unknown,
      filters: [] as [string, string, unknown][],
      columns: undefined as string | undefined,
    };
    const b: Record<string, unknown> = {
      select: (cols?: string) => ((ops.columns = cols), b),
      insert: (p: unknown) => ((ops.type = "insert"), (ops.payload = p), b),
      update: (p: unknown) => ((ops.type = "update"), (ops.payload = p), b),
      eq: (k: string, v: unknown) => (ops.filters.push(["eq", k, v]), b),
      neq: (k: string, v: unknown) => (ops.filters.push(["neq", k, v]), b),
      gte: (k: string, v: unknown) => (ops.filters.push(["gte", k, v]), b),
      gt: (k: string, v: unknown) => (ops.filters.push(["gt", k, v]), b),
      lt: (k: string, v: unknown) => (ops.filters.push(["lt", k, v]), b),
      lte: (k: string, v: unknown) => (ops.filters.push(["lte", k, v]), b),
      in: (k: string, v: unknown) => (ops.filters.push(["in", k, v]), b),
      order: () => b,
      limit: () => b,
      maybeSingle: () => Promise.resolve(resolve(ops, true)),
      then: (onF: (v: unknown) => unknown, onR?: (e: unknown) => unknown) =>
        Promise.resolve(resolve(ops, false)).then(onF, onR),
    };
    return b;
  }

  return {
    supabaseAdmin: () => ({
      from: (t: string) => builder(t),
    }),
  };
});

const emailState = { sendEmail: vi.fn(), configured: true };
vi.mock("@/lib/email/resend", () => {
  class EmailNotConfiguredError extends Error {}
  return {
    EmailNotConfiguredError,
    sendEmail: (...args: unknown[]) => {
      if (!emailState.configured) return Promise.reject(new EmailNotConfiguredError());
      return emailState.sendEmail(...args);
    },
  };
});

import { executeTool, listToolSchemas, type ToolContext } from "./tools";
import type { AiAgentConfig } from "@/types";

const BASE_CONFIG: AiAgentConfig = {
  id: "cfg1",
  account_id: "acct-1",
  enabled: true,
  business_profile: {},
  agent_persona: {},
  services: [{ name: "Haircut", price: "$20", description: "A basic cut" }],
  business_hours: {},
  faqs: [{ question: "What are your hours?", answer: "9 to 5" }],
  escalation_rules: [],
  restricted_topics: [],
  provider_priority: [],
  consequential_action_mode: "auto",
  default_appointment_duration_minutes: 30,
  appointment_reminder_offsets_minutes: [1440, 120],
  reminder_template_language: "en_US",
  created_at: "",
  updated_at: "",
};

// Booking tests need a real future date/weekday rather than a hardcoded
// one, so they stay valid no matter when the suite actually runs.
// Business hours are configured in UTC so the civil date/weekday match
// the UTC values used to build ISO timestamps directly, with no
// timezone-conversion dimension to reason about here — that math is
// already covered independently in booking/availability.test.ts.
const FUTURE_DATE = new Date(Date.now() + 7 * 86_400_000);
const FUTURE_DATE_STR = FUTURE_DATE.toISOString().slice(0, 10);
const FUTURE_DOW = FUTURE_DATE.getUTCDay();
const BOOKING_CONFIG: AiAgentConfig = {
  ...BASE_CONFIG,
  business_hours: { timezone: "UTC", windows: [{ day: FUTURE_DOW, open: "09:00", close: "17:00" }] },
};

function ctx(overrides: Partial<ToolContext> = {}): ToolContext {
  return {
    accountId: "acct-1",
    contactId: "contact-1",
    conversationId: "conv-1",
    config: BASE_CONFIG,
    ...overrides,
  };
}

beforeEach(() => {
  h.state.contact = { id: "contact-1", account_id: "acct-1", name: "Alice", phone: "+1", email: null, company: null };
  h.state.account = { default_currency: "USD" };
  h.state.appointments = [];
  h.state.staffMembers = [];
  h.state.updateCalls = [];
  h.state.insertCalls = [];
  emailState.sendEmail = vi.fn(async () => ({ id: "email-123" }));
  emailState.configured = true;
});

describe("listToolSchemas", () => {
  it("exposes exactly the eleven tools (Phase 1 + Phase 3 booking + email), none with a contact/customer-id parameter", () => {
    const schemas = listToolSchemas();
    expect(schemas.map((s) => s.name).sort()).toEqual([
      "assign_to_human",
      "cancel_booking",
      "check_availability",
      "create_booking",
      "create_lead",
      "get_customer_details",
      "list_upcoming_bookings",
      "reschedule_booking",
      "search_business_knowledge",
      "send_email",
      "update_customer",
    ]);
    // Hard-scoping by construction: no schema should let the model supply
    // a contact/customer id — the executor always binds to the trusted
    // conversation's contact. appointment_id is a deliberate exception
    // (see the module docstring in tools.ts) since a contact can have
    // more than one booking — it's excluded from this check.
    for (const s of schemas) {
      const props = Object.keys(s.input_schema.properties);
      expect(props.some((p) => /contact.?id|customer.?id/i.test(p))).toBe(false);
    }
  });
});

describe("get_customer_details", () => {
  it("returns the bound contact when account scoping matches", async () => {
    const result = await executeTool(ctx(), "get_customer_details", {});
    expect(result).toEqual({
      found: true,
      name: "Alice",
      phone: "+1",
      email: null,
      company: null,
    });
  });

  it("finds nothing when the trusted accountId doesn't match the stored contact's account — hard scoping holds even if the context were ever wrong", async () => {
    const result = await executeTool(
      ctx({ accountId: "different-account" }),
      "get_customer_details",
      {},
    );
    expect(result).toEqual({ found: false });
  });
});

describe("update_customer", () => {
  it("only writes allow-listed fields and scopes the update by id + account_id", async () => {
    const result = await executeTool(ctx(), "update_customer", {
      name: "Bob",
      // Not in the allow-list — must be silently dropped, not written.
      role: "admin",
    });
    expect(result).toEqual({ updated: true, fields: ["name"] });
    expect(h.state.updateCalls).toHaveLength(1);
    const call = h.state.updateCalls[0];
    expect(call.payload).toMatchObject({ name: "Bob" });
    expect(call.payload).not.toHaveProperty("role");
    expect(call.filters).toContainEqual(["eq", "id", "contact-1"]);
    expect(call.filters).toContainEqual(["eq", "account_id", "acct-1"]);
  });

  it("reports nothing updated when no valid fields are supplied", async () => {
    const result = await executeTool(ctx(), "update_customer", { role: "admin" });
    expect(result).toEqual({ updated: false, reason: "no valid fields supplied" });
    expect(h.state.updateCalls).toHaveLength(0);
  });
});

describe("create_lead", () => {
  it("refuses when the account has no default pipeline/stage configured", async () => {
    const result = await executeTool(ctx(), "create_lead", { title: "Interested in spa package" });
    expect(result).toEqual({
      created: false,
      reason: "lead creation is not configured for this business yet",
    });
    expect(h.state.insertCalls).toHaveLength(0);
  });

  it("creates a deal scoped to the trusted account/contact when configured", async () => {
    const configured = ctx({
      config: { ...BASE_CONFIG, default_pipeline_id: "pipe-1", default_stage_id: "stage-1" },
    });
    const result = await executeTool(configured, "create_lead", {
      title: "Interested in spa package",
      value: 100,
    });
    expect(result).toEqual({ created: true, title: "Interested in spa package", value: 100 });
    expect(h.state.insertCalls[0].payload).toMatchObject({
      account_id: "acct-1",
      contact_id: "contact-1",
      pipeline_id: "pipe-1",
      stage_id: "stage-1",
      title: "Interested in spa package",
      value: 100,
      currency: "USD",
    });
  });
});

describe("assign_to_human", () => {
  it("flips the conversation to human_active, scoped to the trusted conversation + account", async () => {
    const result = await executeTool(ctx(), "assign_to_human", { reason: "customer asked for a person" });
    expect(result).toEqual({ assigned: true, reason: "customer asked for a person" });
    const call = h.state.updateCalls.find((c) => c.table === "conversations");
    expect(call?.payload).toMatchObject({ status: "pending", mode: "human_active" });
    expect(call?.filters).toContainEqual(["eq", "id", "conv-1"]);
    expect(call?.filters).toContainEqual(["eq", "account_id", "acct-1"]);
  });
});

describe("search_business_knowledge", () => {
  it("matches FAQs and services case-insensitively", async () => {
    const result = await executeTool(ctx(), "search_business_knowledge", { query: "HOURS" });
    expect(result).toEqual({
      matches: [{ type: "faq", question: "What are your hours?", answer: "9 to 5" }],
    });
  });

  it("reports no match rather than letting the model guess", async () => {
    const result = await executeTool(ctx(), "search_business_knowledge", { query: "parking" });
    expect(result).toEqual({ matches: [], note: "no matching info found" });
  });
});

describe("send_email", () => {
  it("refuses when subject or body is missing", async () => {
    const result = await executeTool(ctx(), "send_email", { subject: "", body: "Hi" });
    expect(result).toEqual({ sent: false, reason: "subject and body are required" });
    expect(emailState.sendEmail).not.toHaveBeenCalled();
  });

  it("refuses when the trusted contact has no email on file", async () => {
    h.state.contact = { ...h.state.contact, email: null };
    const result = await executeTool(ctx(), "send_email", { subject: "Hi", body: "Body" });
    expect(result).toEqual({ sent: false, reason: "the customer doesn't have an email on file" });
    expect(emailState.sendEmail).not.toHaveBeenCalled();
  });

  it("sends to the trusted contact's own email, scoped by account_id — never an id the model could supply", async () => {
    h.state.contact = { ...h.state.contact, email: "alice@example.com" };
    const result = await executeTool(ctx(), "send_email", {
      subject: "Your receipt",
      body: "Thanks for booking!",
    });
    expect(result).toEqual({ sent: true });
    expect(emailState.sendEmail).toHaveBeenCalledWith({
      to: "alice@example.com",
      subject: "Your receipt",
      text: "Thanks for booking!",
    });
  });

  it("reports a friendly reason instead of throwing when email isn't configured on this deployment", async () => {
    h.state.contact = { ...h.state.contact, email: "alice@example.com" };
    emailState.configured = false;
    const result = await executeTool(ctx(), "send_email", { subject: "Hi", body: "Body" });
    expect(result).toEqual({ sent: false, reason: "email is not set up for this business yet" });
  });
});

describe("check_availability", () => {
  it("reports that business hours aren't configured rather than guessing a slot", async () => {
    const result = await executeTool(ctx(), "check_availability", { date: FUTURE_DATE_STR });
    expect(result).toEqual({ slots: [], reason: "business hours are not configured for this business yet" });
  });

  it("returns open slots for a configured day, scoped to the trusted account", async () => {
    const result = await executeTool(
      ctx({ config: BOOKING_CONFIG }),
      "check_availability",
      { date: FUTURE_DATE_STR, service: "Haircut" },
    );
    const slots = result.slots as string[];
    expect(slots.slice(0, 2)).toEqual([
      `${FUTURE_DATE_STR}T09:00:00.000Z`,
      `${FUTURE_DATE_STR}T09:30:00.000Z`,
    ]);
  });

  it("rejects a malformed date instead of passing it through", async () => {
    const result = await executeTool(ctx({ config: BOOKING_CONFIG }), "check_availability", {
      date: "20th August",
    });
    expect(result).toEqual({ slots: [], reason: "date must be in YYYY-MM-DD format" });
  });

  it("excludes a slot already booked by a different contact on the same account", async () => {
    h.state.appointments = [
      {
        id: "appt-other",
        account_id: "acct-1",
        contact_id: "contact-2",
        status: "booked",
        starts_at: `${FUTURE_DATE_STR}T09:00:00.000Z`,
        ends_at: `${FUTURE_DATE_STR}T09:30:00.000Z`,
      },
    ];
    const result = await executeTool(ctx({ config: BOOKING_CONFIG }), "check_availability", {
      date: FUTURE_DATE_STR,
    });
    expect((result.slots as string[])[0]).toBe(`${FUTURE_DATE_STR}T09:30:00.000Z`);
  });
});

describe("list_upcoming_bookings", () => {
  it("returns only the trusted contact's own booked appointments", async () => {
    h.state.appointments = [
      {
        id: "appt-mine",
        account_id: "acct-1",
        contact_id: "contact-1",
        service: "Haircut",
        status: "booked",
        starts_at: `${FUTURE_DATE_STR}T09:00:00.000Z`,
        ends_at: `${FUTURE_DATE_STR}T09:30:00.000Z`,
      },
      {
        id: "appt-someone-elses",
        account_id: "acct-1",
        contact_id: "contact-2",
        service: "Haircut",
        status: "booked",
        starts_at: `${FUTURE_DATE_STR}T10:00:00.000Z`,
        ends_at: `${FUTURE_DATE_STR}T10:30:00.000Z`,
      },
    ];
    const result = await executeTool(ctx(), "list_upcoming_bookings", {});
    expect(result.bookings).toEqual([
      {
        id: "appt-mine",
        service: "Haircut",
        starts_at: `${FUTURE_DATE_STR}T09:00:00.000Z`,
        ends_at: `${FUTURE_DATE_STR}T09:30:00.000Z`,
        staff: null,
      },
    ]);
  });
});

describe("create_booking", () => {
  it("refuses an unconfigured/unknown service", async () => {
    const result = await executeTool(ctx({ config: BOOKING_CONFIG }), "create_booking", {
      service: "Massage",
      start_time: `${FUTURE_DATE_STR}T09:00:00.000Z`,
    });
    expect(result).toMatchObject({ created: false });
    expect((result.reason as string)).toMatch(/unknown service/);
  });

  it("refuses a time outside business hours", async () => {
    const result = await executeTool(ctx({ config: BOOKING_CONFIG }), "create_booking", {
      service: "Haircut",
      start_time: `${FUTURE_DATE_STR}T20:00:00.000Z`,
    });
    expect(result).toEqual({ created: false, reason: "requested time is outside business hours" });
  });

  it("refuses a time that conflicts with an existing booking", async () => {
    h.state.appointments = [
      {
        id: "appt-existing",
        account_id: "acct-1",
        status: "booked",
        starts_at: `${FUTURE_DATE_STR}T09:00:00.000Z`,
        ends_at: `${FUTURE_DATE_STR}T09:30:00.000Z`,
      },
    ];
    const result = await executeTool(ctx({ config: BOOKING_CONFIG }), "create_booking", {
      service: "Haircut",
      start_time: `${FUTURE_DATE_STR}T09:00:00.000Z`,
    });
    expect(result).toEqual({
      created: false,
      reason: "that slot is no longer available — check availability again",
    });
    expect(h.state.insertCalls).toHaveLength(0);
  });

  it("books the appointment scoped to the trusted account/contact/conversation", async () => {
    const result = await executeTool(ctx({ config: BOOKING_CONFIG }), "create_booking", {
      service: "Haircut",
      start_time: `${FUTURE_DATE_STR}T09:00:00.000Z`,
      notes: "prefers the window seat",
    });
    expect(result).toMatchObject({
      created: true,
      service: "Haircut",
      starts_at: `${FUTURE_DATE_STR}T09:00:00.000Z`,
      ends_at: `${FUTURE_DATE_STR}T09:30:00.000Z`,
    });
    expect(h.state.insertCalls).toHaveLength(1);
    expect(h.state.insertCalls[0].payload).toMatchObject({
      account_id: "acct-1",
      contact_id: "contact-1",
      conversation_id: "conv-1",
      service: "Haircut",
      status: "booked",
      created_by: "ai",
      notes: "prefers the window seat",
    });
  });
});

describe("reschedule_booking", () => {
  it("reports not found when the appointment_id doesn't belong to the trusted contact — hard scoping holds even if the model supplies someone else's id", async () => {
    h.state.appointments = [
      {
        id: "appt-someone-elses",
        account_id: "acct-1",
        contact_id: "contact-2",
        status: "booked",
        starts_at: `${FUTURE_DATE_STR}T09:00:00.000Z`,
        ends_at: `${FUTURE_DATE_STR}T09:30:00.000Z`,
      },
    ];
    const result = await executeTool(ctx({ config: BOOKING_CONFIG }), "reschedule_booking", {
      appointment_id: "appt-someone-elses",
      new_start_time: `${FUTURE_DATE_STR}T10:00:00.000Z`,
    });
    expect(result).toEqual({ rescheduled: false, reason: "booking not found" });
    expect(h.state.updateCalls.filter((c) => c.table === "appointments")).toHaveLength(0);
  });

  it("preserves the original duration and moves the appointment scoped to the trusted contact/account", async () => {
    h.state.appointments = [
      {
        id: "appt-mine",
        account_id: "acct-1",
        contact_id: "contact-1",
        status: "booked",
        starts_at: `${FUTURE_DATE_STR}T09:00:00.000Z`,
        ends_at: `${FUTURE_DATE_STR}T09:30:00.000Z`,
      },
    ];
    const result = await executeTool(ctx({ config: BOOKING_CONFIG }), "reschedule_booking", {
      appointment_id: "appt-mine",
      new_start_time: `${FUTURE_DATE_STR}T10:00:00.000Z`,
    });
    expect(result).toEqual({
      rescheduled: true,
      appointment_id: "appt-mine",
      starts_at: `${FUTURE_DATE_STR}T10:00:00.000Z`,
      ends_at: `${FUTURE_DATE_STR}T10:30:00.000Z`,
    });
    const call = h.state.updateCalls.find((c) => c.table === "appointments");
    expect(call?.filters).toContainEqual(["eq", "contact_id", "contact-1"]);
    expect(call?.filters).toContainEqual(["eq", "account_id", "acct-1"]);
  });
});

describe("cancel_booking", () => {
  it("reports not found when the appointment_id doesn't belong to the trusted contact", async () => {
    h.state.appointments = [
      {
        id: "appt-someone-elses",
        account_id: "acct-1",
        contact_id: "contact-2",
        status: "booked",
      },
    ];
    const result = await executeTool(ctx(), "cancel_booking", { appointment_id: "appt-someone-elses" });
    expect(result).toEqual({ cancelled: false, reason: "booking not found" });
  });

  it("cancels the booking scoped to the trusted contact/account", async () => {
    h.state.appointments = [
      { id: "appt-mine", account_id: "acct-1", contact_id: "contact-1", status: "booked" },
    ];
    const result = await executeTool(ctx(), "cancel_booking", {
      appointment_id: "appt-mine",
      reason: "change of plans",
    });
    expect(result).toEqual({ cancelled: true, appointment_id: "appt-mine" });
    const call = h.state.updateCalls.find((c) => c.table === "appointments");
    expect(call?.payload).toMatchObject({ status: "cancelled" });
    expect(call?.filters).toContainEqual(["eq", "contact_id", "contact-1"]);
    expect(call?.filters).toContainEqual(["eq", "account_id", "acct-1"]);
  });
});

describe("booking — named staff / multi-resource", () => {
  const ALICE = { id: "staff-a", account_id: "acct-1", name: "Alice", active: true, working_hours: [] };
  const BOB = { id: "staff-b", account_id: "acct-1", name: "Bob", active: true, working_hours: [] };

  it("check_availability unions free slots across all active staff, not just one", async () => {
    h.state.staffMembers = [ALICE, BOB];
    // Alice is busy at the first slot; Bob is free — the slot should
    // still show up since *someone* can take it.
    h.state.appointments = [
      {
        id: "appt-alice",
        account_id: "acct-1",
        staff_id: "staff-a",
        status: "booked",
        starts_at: `${FUTURE_DATE_STR}T09:00:00.000Z`,
        ends_at: `${FUTURE_DATE_STR}T09:30:00.000Z`,
      },
    ];
    const result = await executeTool(ctx({ config: BOOKING_CONFIG }), "check_availability", {
      date: FUTURE_DATE_STR,
    });
    expect((result.slots as string[])[0]).toBe(`${FUTURE_DATE_STR}T09:00:00.000Z`);
  });

  it("check_availability refuses an unknown staff name", async () => {
    h.state.staffMembers = [ALICE, BOB];
    const result = await executeTool(ctx({ config: BOOKING_CONFIG }), "check_availability", {
      date: FUTURE_DATE_STR,
      staff: "Charlie",
    });
    expect(result).toMatchObject({ slots: [] });
    expect((result.reason as string)).toMatch(/unknown staff member/);
  });

  it("create_booking auto-assigns the first staff member who is actually free", async () => {
    h.state.staffMembers = [ALICE, BOB];
    h.state.appointments = [
      {
        id: "appt-alice",
        account_id: "acct-1",
        staff_id: "staff-a",
        status: "booked",
        starts_at: `${FUTURE_DATE_STR}T09:00:00.000Z`,
        ends_at: `${FUTURE_DATE_STR}T09:30:00.000Z`,
      },
    ];
    const result = await executeTool(ctx({ config: BOOKING_CONFIG }), "create_booking", {
      service: "Haircut",
      start_time: `${FUTURE_DATE_STR}T09:00:00.000Z`,
    });
    expect(result).toMatchObject({ created: true, staff: "Bob" });
    expect(h.state.insertCalls[0].payload).toMatchObject({ staff_id: "staff-b" });
  });

  it("create_booking refuses when the explicitly requested staff member is busy, without trying anyone else", async () => {
    h.state.staffMembers = [ALICE, BOB];
    h.state.appointments = [
      {
        id: "appt-alice",
        account_id: "acct-1",
        staff_id: "staff-a",
        status: "booked",
        starts_at: `${FUTURE_DATE_STR}T09:00:00.000Z`,
        ends_at: `${FUTURE_DATE_STR}T09:30:00.000Z`,
      },
    ];
    const result = await executeTool(ctx({ config: BOOKING_CONFIG }), "create_booking", {
      service: "Haircut",
      start_time: `${FUTURE_DATE_STR}T09:00:00.000Z`,
      staff: "Alice",
    });
    expect(result).toMatchObject({ created: false });
    expect((result.reason as string)).toMatch(/Alice is not available/);
    expect(h.state.insertCalls).toHaveLength(0);
  });

  it("create_booking refuses when every active staff member is busy at that time", async () => {
    h.state.staffMembers = [ALICE, BOB];
    h.state.appointments = [
      {
        id: "appt-alice",
        account_id: "acct-1",
        staff_id: "staff-a",
        status: "booked",
        starts_at: `${FUTURE_DATE_STR}T09:00:00.000Z`,
        ends_at: `${FUTURE_DATE_STR}T09:30:00.000Z`,
      },
      {
        id: "appt-bob",
        account_id: "acct-1",
        staff_id: "staff-b",
        status: "booked",
        starts_at: `${FUTURE_DATE_STR}T09:00:00.000Z`,
        ends_at: `${FUTURE_DATE_STR}T09:30:00.000Z`,
      },
    ];
    const result = await executeTool(ctx({ config: BOOKING_CONFIG }), "create_booking", {
      service: "Haircut",
      start_time: `${FUTURE_DATE_STR}T09:00:00.000Z`,
    });
    expect(result).toEqual({
      created: false,
      reason: "no staff available at that time — check availability again",
    });
  });

  it("reschedule_booking preserves the original staff assignment and only checks that staff's calendar for conflicts", async () => {
    h.state.staffMembers = [ALICE, BOB];
    h.state.appointments = [
      {
        id: "appt-mine",
        account_id: "acct-1",
        contact_id: "contact-1",
        staff_id: "staff-a",
        status: "booked",
        starts_at: `${FUTURE_DATE_STR}T09:00:00.000Z`,
        ends_at: `${FUTURE_DATE_STR}T09:30:00.000Z`,
      },
      // Bob has a booking at the target time — should NOT block moving
      // Alice's appointment there, since they're different staff.
      {
        id: "appt-bob",
        account_id: "acct-1",
        staff_id: "staff-b",
        status: "booked",
        starts_at: `${FUTURE_DATE_STR}T10:00:00.000Z`,
        ends_at: `${FUTURE_DATE_STR}T10:30:00.000Z`,
      },
    ];
    const result = await executeTool(ctx({ config: BOOKING_CONFIG }), "reschedule_booking", {
      appointment_id: "appt-mine",
      new_start_time: `${FUTURE_DATE_STR}T10:00:00.000Z`,
    });
    expect(result).toMatchObject({ rescheduled: true, appointment_id: "appt-mine" });
  });
});

describe("executeTool", () => {
  it("returns an error result instead of throwing for an unknown tool name", async () => {
    const result = await executeTool(ctx(), "delete_everything", {});
    expect(result).toEqual({ error: "unknown tool: delete_everything" });
  });
});
