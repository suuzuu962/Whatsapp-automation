import { describe, it, expect } from "vitest";
import {
  isOptOutMessage,
  isOptInMessage,
  assertNotOptedOut,
  ContactOptedOutError,
} from "./opt-out";

describe("isOptOutMessage", () => {
  it.each(["stop", "STOP", " Stop ", "Unsubscribe", "cancel", "opt out", "quit", "end", "remove me"])(
    "matches a whole-message opt-out keyword: %s",
    (text) => {
      expect(isOptOutMessage(text)).toBe(true);
    },
  );

  it.each([
    "please don't stop texting me",
    "when does the offer end",
    "can you cancel my appointment instead",
    "stop it, that's funny",
    "hi there",
  ])("does not match when the keyword is only part of a longer message: %s", (text) => {
    expect(isOptOutMessage(text)).toBe(false);
  });

  it("matches through trailing punctuation", () => {
    expect(isOptOutMessage("STOP!")).toBe(true);
    expect(isOptOutMessage("stop.")).toBe(true);
  });
});

describe("isOptInMessage", () => {
  it.each(["start", "START", "subscribe", "opt in", "unstop"])(
    "matches a whole-message opt-in keyword: %s",
    (text) => {
      expect(isOptInMessage(text)).toBe(true);
    },
  );

  it("does not match when embedded in a longer message", () => {
    expect(isOptInMessage("can we start tomorrow instead")).toBe(false);
  });
});

describe("assertNotOptedOut", () => {
  it("does not throw for a contact with no opted_out_at", () => {
    expect(() => assertNotOptedOut({ opted_out_at: null })).not.toThrow();
    expect(() => assertNotOptedOut({})).not.toThrow();
  });

  it("throws ContactOptedOutError for an opted-out contact", () => {
    expect(() => assertNotOptedOut({ opted_out_at: "2026-08-01T00:00:00Z" })).toThrow(
      ContactOptedOutError,
    );
  });
});
