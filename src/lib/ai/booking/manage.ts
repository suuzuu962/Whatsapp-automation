import { randomUUID } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { AiAgentConfig } from "@/types";
import { isWithinBusinessHours, resolveDurationMinutes } from "./availability";

/**
 * Shared create/reschedule/cancel booking logic — used by both the AI
 * agent's tools (tools.ts, via the admin client, hard-scoped to a
 * trusted context) and the human-facing appointments API routes (via
 * the caller's RLS-scoped client). Extracted so business-hours
 * validation and conflict-checking have exactly one implementation
 * regardless of who's booking — an AI-only copy would silently drift
 * from what a human agent is allowed to do in the CRM directly.
 *
 * Takes a `SupabaseClient` rather than importing one so each caller
 * keeps its own trust model: the AI tools intentionally bypass RLS
 * (every filter is still hard-scoped to the trusted accountId/contactId
 * from the webhook), while the API routes intentionally rely on RLS
 * (`appointments_insert`/`appointments_update` require the 'agent' role
 * — see 029_ai_booking.sql).
 */

interface StaffRow {
  id: string;
  name: string;
  working_hours: { day: number; open: string; close: string }[];
}

async function loadActiveStaff(
  db: SupabaseClient,
  accountId: string,
): Promise<StaffRow[]> {
  const { data, error } = await db
    .from("staff_members")
    .select("id, name, working_hours")
    .eq("account_id", accountId)
    .eq("active", true);
  if (error) throw new Error(`staff lookup failed: ${error.message}`);
  return (data ?? []) as StaffRow[];
}

function effectiveStaffWindows(
  staff: { working_hours: { day: number; open: string; close: string }[] },
  accountWindows: { day: number; open: string; close: string }[],
) {
  return staff.working_hours.length > 0 ? staff.working_hours : accountWindows;
}

export interface CreateAppointmentArgs {
  accountId: string;
  contactId: string;
  conversationId?: string | null;
  config: AiAgentConfig;
  service: string;
  start: Date;
  notes?: string | null;
  /** A specific staff member's name, if requested. Omit to auto-assign
   *  whoever is free (or to use the account's shared calendar when the
   *  account has no staff configured at all). */
  staffName?: string;
  createdBy: "ai" | "human";
}

export type CreateAppointmentResult =
  | {
      created: true;
      appointment_id: string;
      service: string;
      staff?: string;
      starts_at: string;
      ends_at: string;
    }
  | { created: false; reason: string };

export async function createAppointment(
  db: SupabaseClient,
  args: CreateAppointmentArgs,
): Promise<CreateAppointmentResult> {
  const { accountId, contactId, config, service, start } = args;
  const notes = args.notes?.trim() || null;

  if (!service.trim()) return { created: false, reason: "service is required" };
  if (Number.isNaN(start.getTime())) {
    return { created: false, reason: "start_time must be a valid date-time" };
  }
  if (start.getTime() < Date.now()) {
    return { created: false, reason: "start_time is in the past" };
  }

  const configuredServices = config.services ?? [];
  if (
    configuredServices.length > 0 &&
    !configuredServices.some((s) => s.name.toLowerCase() === service.toLowerCase())
  ) {
    return {
      created: false,
      reason: `unknown service — offered services are: ${configuredServices.map((s) => s.name).join(", ")}`,
    };
  }

  const accountWindows = config.business_hours?.windows ?? [];
  const timezone = config.business_hours?.timezone || "UTC";
  const durationMinutes = resolveDurationMinutes(
    service,
    configuredServices,
    config.default_appointment_duration_minutes ?? 30,
  );
  const end = new Date(start.getTime() + durationMinutes * 60_000);

  const activeStaff = await loadActiveStaff(db, accountId);

  if (activeStaff.length === 0) {
    if (accountWindows.length === 0) {
      return { created: false, reason: "business hours are not configured for this business yet" };
    }
    if (!isWithinBusinessHours(start, end, timezone, accountWindows)) {
      return { created: false, reason: "requested time is outside business hours" };
    }
    const { data: conflicts, error: conflictErr } = await db
      .from("appointments")
      .select("id")
      .eq("account_id", accountId)
      .eq("status", "booked")
      .lt("starts_at", end.toISOString())
      .gt("ends_at", start.toISOString());
    if (conflictErr) throw new Error(`create_booking failed: ${conflictErr.message}`);
    if (conflicts && conflicts.length > 0) {
      return { created: false, reason: "that slot is no longer available — check availability again" };
    }
    const appointmentId = randomUUID();
    const { error } = await db.from("appointments").insert({
      id: appointmentId,
      account_id: accountId,
      contact_id: contactId,
      conversation_id: args.conversationId ?? null,
      service,
      starts_at: start.toISOString(),
      ends_at: end.toISOString(),
      status: "booked",
      notes,
      created_by: args.createdBy,
      staff_id: null,
    });
    if (error) throw new Error(`create_booking failed: ${error.message}`);
    return {
      created: true,
      appointment_id: appointmentId,
      service,
      starts_at: start.toISOString(),
      ends_at: end.toISOString(),
    };
  }

  let candidates = activeStaff;
  const staffArg = args.staffName?.trim();
  if (staffArg) {
    const match = activeStaff.find((s) => s.name.toLowerCase() === staffArg.toLowerCase());
    if (!match) {
      return {
        created: false,
        reason: `unknown staff member — available: ${activeStaff.map((s) => s.name).join(", ")}`,
      };
    }
    candidates = [match];
  }

  for (const staff of candidates) {
    const windows = effectiveStaffWindows(staff, accountWindows);
    if (windows.length === 0 || !isWithinBusinessHours(start, end, timezone, windows)) continue;

    const { data: conflicts, error: conflictErr } = await db
      .from("appointments")
      .select("id")
      .eq("account_id", accountId)
      .eq("staff_id", staff.id)
      .eq("status", "booked")
      .lt("starts_at", end.toISOString())
      .gt("ends_at", start.toISOString());
    if (conflictErr) throw new Error(`create_booking failed: ${conflictErr.message}`);
    if (conflicts && conflicts.length > 0) continue;

    const appointmentId = randomUUID();
    const { error } = await db.from("appointments").insert({
      id: appointmentId,
      account_id: accountId,
      contact_id: contactId,
      conversation_id: args.conversationId ?? null,
      service,
      starts_at: start.toISOString(),
      ends_at: end.toISOString(),
      status: "booked",
      notes,
      created_by: args.createdBy,
      staff_id: staff.id,
    });
    if (error) throw new Error(`create_booking failed: ${error.message}`);
    return {
      created: true,
      appointment_id: appointmentId,
      service,
      staff: staff.name,
      starts_at: start.toISOString(),
      ends_at: end.toISOString(),
    };
  }

  return {
    created: false,
    reason: staffArg
      ? `${staffArg} is not available at that time — check availability again`
      : "no staff available at that time — check availability again",
  };
}

export interface RescheduleAppointmentArgs {
  accountId: string;
  contactId: string;
  config: AiAgentConfig;
  appointmentId: string;
  newStart: Date;
}

export type RescheduleAppointmentResult =
  | { rescheduled: true; appointment_id: string; starts_at: string; ends_at: string }
  | { rescheduled: false; reason: string };

export async function rescheduleAppointment(
  db: SupabaseClient,
  args: RescheduleAppointmentArgs,
): Promise<RescheduleAppointmentResult> {
  const { accountId, contactId, config, appointmentId, newStart } = args;
  if (!appointmentId) return { rescheduled: false, reason: "appointment_id is required" };
  if (Number.isNaN(newStart.getTime())) {
    return { rescheduled: false, reason: "new_start_time must be a valid date-time" };
  }

  const { data: existing, error: fetchErr } = await db
    .from("appointments")
    .select("starts_at, ends_at, staff_id")
    .eq("id", appointmentId)
    .eq("contact_id", contactId)
    .eq("account_id", accountId)
    .eq("status", "booked")
    .maybeSingle();
  if (fetchErr) throw new Error(`reschedule_booking failed: ${fetchErr.message}`);
  if (!existing) return { rescheduled: false, reason: "booking not found" };
  if (newStart.getTime() < Date.now()) {
    return { rescheduled: false, reason: "new_start_time is in the past" };
  }

  const existingRow = existing as { starts_at: string; ends_at: string; staff_id: string | null };
  const durationMs =
    new Date(existingRow.ends_at).getTime() - new Date(existingRow.starts_at).getTime();
  const newEnd = new Date(newStart.getTime() + durationMs);

  const accountWindows = config.business_hours?.windows ?? [];
  const timezone = config.business_hours?.timezone || "UTC";

  let windows = accountWindows;
  if (existingRow.staff_id) {
    const { data: staffRow } = await db
      .from("staff_members")
      .select("working_hours")
      .eq("id", existingRow.staff_id)
      .maybeSingle();
    if (staffRow) {
      windows = effectiveStaffWindows(
        staffRow as { working_hours: { day: number; open: string; close: string }[] },
        accountWindows,
      );
    }
  }
  if (windows.length > 0 && !isWithinBusinessHours(newStart, newEnd, timezone, windows)) {
    return { rescheduled: false, reason: "requested time is outside business hours" };
  }

  let conflictQuery = db
    .from("appointments")
    .select("id")
    .eq("account_id", accountId)
    .eq("status", "booked")
    .neq("id", appointmentId)
    .lt("starts_at", newEnd.toISOString())
    .gt("ends_at", newStart.toISOString());
  if (existingRow.staff_id) {
    conflictQuery = conflictQuery.eq("staff_id", existingRow.staff_id);
  }
  const { data: conflicts, error: conflictErr } = await conflictQuery;
  if (conflictErr) throw new Error(`reschedule_booking failed: ${conflictErr.message}`);
  if (conflicts && conflicts.length > 0) {
    return { rescheduled: false, reason: "that slot is no longer available" };
  }

  const { error } = await db
    .from("appointments")
    .update({
      starts_at: newStart.toISOString(),
      ends_at: newEnd.toISOString(),
      updated_at: new Date().toISOString(),
    })
    .eq("id", appointmentId)
    .eq("contact_id", contactId)
    .eq("account_id", accountId);
  if (error) throw new Error(`reschedule_booking failed: ${error.message}`);
  return {
    rescheduled: true,
    appointment_id: appointmentId,
    starts_at: newStart.toISOString(),
    ends_at: newEnd.toISOString(),
  };
}

export interface CancelAppointmentArgs {
  accountId: string;
  contactId: string;
  appointmentId: string;
}

export type CancelAppointmentResult =
  | { cancelled: true; appointment_id: string }
  | { cancelled: false; reason: string };

export async function cancelAppointment(
  db: SupabaseClient,
  args: CancelAppointmentArgs,
): Promise<CancelAppointmentResult> {
  const { accountId, contactId, appointmentId } = args;
  if (!appointmentId) return { cancelled: false, reason: "appointment_id is required" };

  const { data: existing, error: fetchErr } = await db
    .from("appointments")
    .select("id")
    .eq("id", appointmentId)
    .eq("contact_id", contactId)
    .eq("account_id", accountId)
    .eq("status", "booked")
    .maybeSingle();
  if (fetchErr) throw new Error(`cancel_booking failed: ${fetchErr.message}`);
  if (!existing) return { cancelled: false, reason: "booking not found" };

  const { error } = await db
    .from("appointments")
    .update({ status: "cancelled", updated_at: new Date().toISOString() })
    .eq("id", appointmentId)
    .eq("contact_id", contactId)
    .eq("account_id", accountId);
  if (error) throw new Error(`cancel_booking failed: ${error.message}`);
  return { cancelled: true, appointment_id: appointmentId };
}
