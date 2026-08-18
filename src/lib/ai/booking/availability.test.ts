import { describe, it, expect } from "vitest";
import {
  computeAvailableSlots,
  isWithinBusinessHours,
  resolveDurationMinutes,
} from "./availability";

const THURSDAY_WINDOW = [{ day: 4, open: "09:00", close: "11:00" }]; // 2026-08-20 is a Thursday
const FAR_PAST = new Date("2000-01-01T00:00:00Z");

describe("computeAvailableSlots", () => {
  it("returns every non-overlapping duration-sized slot within the window when nothing is booked", () => {
    const slots = computeAvailableSlots({
      dateStr: "2026-08-20",
      timezone: "Asia/Kolkata",
      windows: THURSDAY_WINDOW,
      durationMinutes: 30,
      existing: [],
      now: FAR_PAST,
    });
    expect(slots).toEqual([
      { start: "2026-08-20T03:30:00.000Z", end: "2026-08-20T04:00:00.000Z" },
      { start: "2026-08-20T04:00:00.000Z", end: "2026-08-20T04:30:00.000Z" },
      { start: "2026-08-20T04:30:00.000Z", end: "2026-08-20T05:00:00.000Z" },
      { start: "2026-08-20T05:00:00.000Z", end: "2026-08-20T05:30:00.000Z" },
    ]);
  });

  it("returns nothing for a date whose weekday has no configured window", () => {
    const slots = computeAvailableSlots({
      dateStr: "2026-08-19", // Wednesday — no window configured
      timezone: "Asia/Kolkata",
      windows: THURSDAY_WINDOW,
      durationMinutes: 30,
      existing: [],
      now: FAR_PAST,
    });
    expect(slots).toEqual([]);
  });

  it("excludes a slot that overlaps an existing booked appointment", () => {
    const slots = computeAvailableSlots({
      dateStr: "2026-08-20",
      timezone: "Asia/Kolkata",
      windows: THURSDAY_WINDOW,
      durationMinutes: 30,
      existing: [{ starts_at: "2026-08-20T04:00:00.000Z", ends_at: "2026-08-20T04:30:00.000Z" }],
      now: FAR_PAST,
    });
    expect(slots.map((s) => s.start)).toEqual([
      "2026-08-20T03:30:00.000Z",
      "2026-08-20T04:30:00.000Z",
      "2026-08-20T05:00:00.000Z",
    ]);
  });

  it("excludes slots that have already started relative to `now`", () => {
    const slots = computeAvailableSlots({
      dateStr: "2026-08-20",
      timezone: "Asia/Kolkata",
      windows: THURSDAY_WINDOW,
      durationMinutes: 30,
      existing: [],
      now: new Date("2026-08-20T04:15:00.000Z"),
    });
    expect(slots.map((s) => s.start)).toEqual([
      "2026-08-20T04:30:00.000Z",
      "2026-08-20T05:00:00.000Z",
    ]);
  });

  it("does not return a slot that would run past the window close", () => {
    const slots = computeAvailableSlots({
      dateStr: "2026-08-20",
      timezone: "Asia/Kolkata",
      windows: [{ day: 4, open: "09:00", close: "09:45" }],
      durationMinutes: 30,
      existing: [],
      now: FAR_PAST,
    });
    // Only one 30-minute slot fits in a 45-minute window; a second would
    // end at 09:45+30=10:15, past close.
    expect(slots).toHaveLength(1);
  });

  it("caps the number of returned slots even for a very long window", () => {
    const slots = computeAvailableSlots({
      dateStr: "2026-08-20",
      timezone: "Asia/Kolkata",
      windows: [{ day: 4, open: "00:00", close: "23:59" }],
      durationMinutes: 15,
      existing: [],
      now: FAR_PAST,
    });
    expect(slots.length).toBeLessThanOrEqual(12);
  });
});

describe("isWithinBusinessHours", () => {
  it("accepts a range fully inside a configured window", () => {
    const start = new Date("2026-08-20T03:30:00.000Z"); // 09:00 IST
    const end = new Date("2026-08-20T04:00:00.000Z"); // 09:30 IST
    expect(isWithinBusinessHours(start, end, "Asia/Kolkata", THURSDAY_WINDOW)).toBe(true);
  });

  it("rejects a range that starts before the window opens", () => {
    const start = new Date("2026-08-20T02:30:00.000Z"); // 08:00 IST
    const end = new Date("2026-08-20T03:00:00.000Z"); // 08:30 IST
    expect(isWithinBusinessHours(start, end, "Asia/Kolkata", THURSDAY_WINDOW)).toBe(false);
  });

  it("rejects a range that ends after the window closes", () => {
    const start = new Date("2026-08-20T05:15:00.000Z"); // 10:45 IST
    const end = new Date("2026-08-20T05:45:00.000Z"); // 11:15 IST — past 11:00 close
    expect(isWithinBusinessHours(start, end, "Asia/Kolkata", THURSDAY_WINDOW)).toBe(false);
  });

  it("rejects a range on a day with no configured window", () => {
    const start = new Date("2026-08-19T03:30:00.000Z"); // Wednesday
    const end = new Date("2026-08-19T04:00:00.000Z");
    expect(isWithinBusinessHours(start, end, "Asia/Kolkata", THURSDAY_WINDOW)).toBe(false);
  });
});

describe("resolveDurationMinutes", () => {
  const services = [
    { name: "Haircut", duration_minutes: 45 },
    { name: "Consultation" }, // no duration of its own
  ];

  it("uses the service's own duration when set", () => {
    expect(resolveDurationMinutes("Haircut", services, 30)).toBe(45);
  });

  it("matches case-insensitively", () => {
    expect(resolveDurationMinutes("haircut", services, 30)).toBe(45);
  });

  it("falls back to the account default when the service has no duration set", () => {
    expect(resolveDurationMinutes("Consultation", services, 30)).toBe(30);
  });

  it("falls back to the account default when the service is unknown", () => {
    expect(resolveDurationMinutes("Massage", services, 30)).toBe(30);
  });
});
