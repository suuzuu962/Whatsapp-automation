import { describe, it, expect } from "vitest";
import { buildReminderText, buildReminderTemplateParams } from "./reminders";

describe("buildReminderText", () => {
  it("describes a 24-hour lead time in hours", () => {
    const text = buildReminderText({
      service: "Haircut",
      startsAt: "2026-08-20T09:00:00.000Z",
      timezone: "UTC",
      offsetMinutes: 1440,
    });
    expect(text).toMatch(/^Reminder: your Haircut appointment is in 24 hours, on /);
  });

  it("describes a 2-hour lead time using singular/plural correctly", () => {
    const oneHour = buildReminderText({
      service: "Consultation",
      startsAt: "2026-08-20T09:00:00.000Z",
      timezone: "UTC",
      offsetMinutes: 60,
    });
    expect(oneHour).toMatch(/is in 1 hour,/);

    const twoHours = buildReminderText({
      service: "Consultation",
      startsAt: "2026-08-20T09:00:00.000Z",
      timezone: "UTC",
      offsetMinutes: 120,
    });
    expect(twoHours).toMatch(/is in 2 hours,/);
  });

  it("describes a sub-hour lead time in minutes", () => {
    const text = buildReminderText({
      service: "Consultation",
      startsAt: "2026-08-20T09:00:00.000Z",
      timezone: "UTC",
      offsetMinutes: 30,
    });
    expect(text).toMatch(/is in 30 minutes,/);
  });

  it("formats the appointment time in the business's own timezone, not UTC", () => {
    const utcText = buildReminderText({
      service: "Haircut",
      startsAt: "2026-08-20T09:00:00.000Z",
      timezone: "UTC",
      offsetMinutes: 120,
    });
    const istText = buildReminderText({
      service: "Haircut",
      startsAt: "2026-08-20T09:00:00.000Z",
      timezone: "Asia/Kolkata",
      offsetMinutes: 120,
    });
    expect(utcText).not.toBe(istText);
  });
});

describe("buildReminderTemplateParams", () => {
  it("returns [service, formatted time] as positional body variables", () => {
    const result = buildReminderTemplateParams({
      service: "Haircut",
      startsAt: "2026-08-20T09:00:00.000Z",
      timezone: "UTC",
    });
    expect(result).toHaveLength(2);
    expect(result[0]).toBe("Haircut");
    expect(typeof result[1]).toBe("string");
    expect(result[1].length).toBeGreaterThan(0);
  });
});
