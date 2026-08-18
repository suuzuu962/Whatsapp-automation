import { describe, it, expect } from "vitest";
import { dayOfWeekInZone, parseDateStr, parseTimeStr, zonedTimeToUtc } from "./timezone";

describe("zonedTimeToUtc", () => {
  it("converts a civil time in a fixed-offset zone (Asia/Kolkata, UTC+5:30)", () => {
    const utc = zonedTimeToUtc(2026, 8, 20, 9, 0, "Asia/Kolkata");
    expect(utc.toISOString()).toBe("2026-08-20T03:30:00.000Z");
  });

  it("converts a civil time in a DST-observing zone during daylight time (America/New_York, EDT = UTC-4 in August)", () => {
    const utc = zonedTimeToUtc(2026, 8, 20, 9, 0, "America/New_York");
    expect(utc.toISOString()).toBe("2026-08-20T13:00:00.000Z");
  });

  it("converts a civil time in a DST-observing zone during standard time (America/New_York, EST = UTC-5 in January)", () => {
    const utc = zonedTimeToUtc(2026, 1, 20, 9, 0, "America/New_York");
    expect(utc.toISOString()).toBe("2026-01-20T14:00:00.000Z");
  });

  it("round-trips through UTC itself", () => {
    const utc = zonedTimeToUtc(2026, 8, 20, 9, 0, "UTC");
    expect(utc.toISOString()).toBe("2026-08-20T09:00:00.000Z");
  });
});

describe("dayOfWeekInZone", () => {
  it("returns the correct weekday (0=Sun..6=Sat) for a known date", () => {
    // 2026-08-20 is a Thursday.
    expect(dayOfWeekInZone(2026, 8, 20, "Asia/Kolkata")).toBe(4);
    // 2026-08-17 is a Monday.
    expect(dayOfWeekInZone(2026, 8, 17, "UTC")).toBe(1);
  });

  it("agrees across zones on opposite sides of the international date line for the same UTC instant's local calendar date", () => {
    // Just after midnight local time in Auckland is still the previous
    // evening in Los Angeles — both should report their own correct
    // civil weekday for the date string given, not drift into the
    // other's day.
    expect(dayOfWeekInZone(2026, 8, 20, "Pacific/Auckland")).toBe(4);
    expect(dayOfWeekInZone(2026, 8, 20, "America/Los_Angeles")).toBe(4);
  });
});

describe("parseDateStr", () => {
  it("parses a valid YYYY-MM-DD string", () => {
    expect(parseDateStr("2026-08-20")).toEqual({ year: 2026, month: 8, day: 20 });
  });

  it("throws on an invalid shape", () => {
    expect(() => parseDateStr("08/20/2026")).toThrow();
    expect(() => parseDateStr("not-a-date")).toThrow();
  });
});

describe("parseTimeStr", () => {
  it("parses a valid HH:MM string", () => {
    expect(parseTimeStr("09:30")).toEqual({ hour: 9, minute: 30 });
    expect(parseTimeStr("17:00")).toEqual({ hour: 17, minute: 0 });
  });

  it("throws on an invalid shape", () => {
    expect(() => parseTimeStr("9am")).toThrow();
  });
});
