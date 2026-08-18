import type { AiBusinessHoursWindow } from "@/types";
import { dayOfWeekInZone, parseDateStr, parseTimeStr, zonedTimeToUtc } from "./timezone";

/**
 * Pure slot-computation logic for the booking tools (check_availability /
 * create_booking / reschedule_booking) in ../tools.ts. Kept dependency-free
 * of the database and of any provider — every function here takes
 * already-loaded data and returns a plain value, so it's fully unit
 * testable without mocking Supabase.
 */

export interface ExistingBooking {
  starts_at: string; // ISO
  ends_at: string; // ISO
}

export interface Slot {
  start: string; // ISO (UTC)
  end: string; // ISO (UTC)
}

const DEFAULT_SLOT_INTERVAL_MINUTES = 30;
// Hard cap on how many slots a single check_availability call returns —
// keeps the tool result small regardless of how long the business's
// window is or how fine the interval, and keeps token usage bounded.
const MAX_SLOTS_RETURNED = 12;

function overlaps(aStart: Date, aEnd: Date, bStart: Date, bEnd: Date): boolean {
  return aStart < bEnd && aEnd > bStart;
}

/**
 * All bookable slots of `durationMinutes` on `dateStr` (a "YYYY-MM-DD"
 * civil date in the business's own timezone), given its configured
 * business-hours windows and any bookings that already exist that day.
 * Excludes slots that have already passed and slots that would conflict
 * with an existing booked appointment.
 */
export function computeAvailableSlots(input: {
  dateStr: string;
  timezone: string;
  windows: AiBusinessHoursWindow[];
  durationMinutes: number;
  existing: ExistingBooking[];
  now?: Date;
  slotIntervalMinutes?: number;
}): Slot[] {
  const { dateStr, timezone, windows, durationMinutes, existing } = input;
  const now = input.now ?? new Date();
  const intervalMinutes = input.slotIntervalMinutes ?? DEFAULT_SLOT_INTERVAL_MINUTES;

  const { year, month, day } = parseDateStr(dateStr);
  const targetDow = dayOfWeekInZone(year, month, day, timezone);
  const todaysWindows = windows.filter((w) => w.day === targetDow);
  if (todaysWindows.length === 0) return [];

  const existingRanges = existing.map((e) => ({
    start: new Date(e.starts_at),
    end: new Date(e.ends_at),
  }));

  const slots: Slot[] = [];
  for (const window of todaysWindows) {
    const open = parseTimeStr(window.open);
    const close = parseTimeStr(window.close);
    const windowStart = zonedTimeToUtc(year, month, day, open.hour, open.minute, timezone);
    const windowEnd = zonedTimeToUtc(year, month, day, close.hour, close.minute, timezone);

    let cursor = windowStart;
    while (cursor.getTime() + durationMinutes * 60_000 <= windowEnd.getTime()) {
      const slotEnd = new Date(cursor.getTime() + durationMinutes * 60_000);
      const inPast = cursor < now;
      const conflicted = existingRanges.some((r) => overlaps(cursor, slotEnd, r.start, r.end));
      if (!inPast && !conflicted) {
        slots.push({ start: cursor.toISOString(), end: slotEnd.toISOString() });
        if (slots.length >= MAX_SLOTS_RETURNED) return slots;
      }
      cursor = new Date(cursor.getTime() + intervalMinutes * 60_000);
    }
  }
  return slots;
}

/**
 * Whether [startUtc, endUtc) falls entirely within one configured
 * business-hours window on its own civil date — used by create_booking
 * and reschedule_booking to reject a time the model didn't actually get
 * from check_availability (or that's stale by the time the call lands).
 */
export function isWithinBusinessHours(
  startUtc: Date,
  endUtc: Date,
  timezone: string,
  windows: AiBusinessHoursWindow[],
): boolean {
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
  const parts = Object.fromEntries(fmt.formatToParts(startUtc).map((p) => [p.type, p.value]));
  const year = Number(parts.year);
  const month = Number(parts.month);
  const day = Number(parts.day);
  const targetDow = dayOfWeekInZone(year, month, day, timezone);

  return windows
    .filter((w) => w.day === targetDow)
    .some((w) => {
      const open = parseTimeStr(w.open);
      const close = parseTimeStr(w.close);
      const windowStart = zonedTimeToUtc(year, month, day, open.hour, open.minute, timezone);
      const windowEnd = zonedTimeToUtc(year, month, day, close.hour, close.minute, timezone);
      return startUtc >= windowStart && endUtc <= windowEnd;
    });
}

/** Resolves the duration to use for a named service, falling back to
 *  the account's default when the service is unlisted or has no
 *  duration of its own. */
export function resolveDurationMinutes(
  serviceName: string,
  services: { name: string; duration_minutes?: number }[],
  defaultDurationMinutes: number,
): number {
  const match = services.find((s) => s.name.toLowerCase() === serviceName.toLowerCase());
  return match?.duration_minutes ?? defaultDurationMinutes;
}
