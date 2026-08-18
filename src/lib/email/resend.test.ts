import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { sendEmail, isEmailConfigured, EmailNotConfiguredError } from "./resend";

const ORIGINAL_ENV = { ...process.env };

afterEach(() => {
  vi.unstubAllGlobals();
  process.env = { ...ORIGINAL_ENV };
});

describe("isEmailConfigured", () => {
  it("is false when either env var is missing", () => {
    process.env.RESEND_API_KEY = "";
    process.env.RESEND_FROM_EMAIL = "";
    expect(isEmailConfigured()).toBe(false);

    process.env.RESEND_API_KEY = "re_test";
    process.env.RESEND_FROM_EMAIL = "";
    expect(isEmailConfigured()).toBe(false);
  });

  it("is true when both are set", () => {
    process.env.RESEND_API_KEY = "re_test";
    process.env.RESEND_FROM_EMAIL = "hello@example.com";
    expect(isEmailConfigured()).toBe(true);
  });
});

describe("sendEmail", () => {
  beforeEach(() => {
    process.env.RESEND_API_KEY = "re_test";
    process.env.RESEND_FROM_EMAIL = "hello@example.com";
  });

  it("throws EmailNotConfiguredError when the env vars aren't set, without calling fetch", async () => {
    process.env.RESEND_API_KEY = "";
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      sendEmail({ to: "customer@example.com", subject: "Hi", text: "Body" }),
    ).rejects.toThrow(EmailNotConfiguredError);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("posts to Resend's API with the configured from-address and returns the id", async () => {
    const fetchMock = vi.fn(async (url: string, init: RequestInit) => {
      expect(url).toBe("https://api.resend.com/emails");
      expect(init.headers).toMatchObject({ Authorization: "Bearer re_test" });
      const body = JSON.parse(init.body as string);
      expect(body).toEqual({
        from: "hello@example.com",
        to: "customer@example.com",
        subject: "Hi",
        text: "Body",
      });
      return new Response(JSON.stringify({ id: "email-123" }), { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await sendEmail({ to: "customer@example.com", subject: "Hi", text: "Body" });
    expect(result).toEqual({ id: "email-123" });
  });

  it("throws with the response body when Resend rejects the request", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("Invalid `from` address", { status: 422 })),
    );

    await expect(
      sendEmail({ to: "customer@example.com", subject: "Hi", text: "Body" }),
    ).rejects.toThrow(/422/);
  });
});
