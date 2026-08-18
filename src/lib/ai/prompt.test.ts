import { describe, it, expect } from "vitest";
import { buildSystemPrompt } from "./prompt";
import type { AiAgentConfig } from "@/types";

const BASE_CONFIG: AiAgentConfig = {
  id: "cfg1",
  account_id: "acct-1",
  enabled: true,
  business_profile: { name: "Glow Dental" },
  agent_persona: {},
  services: [],
  business_hours: {},
  faqs: [],
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

describe("buildSystemPrompt — booking guidance", () => {
  it("omits booking instructions when no business hours are configured", () => {
    const prompt = buildSystemPrompt(BASE_CONFIG);
    expect(prompt).not.toMatch(/check_availability/);
  });

  it("includes booking instructions once business hours are configured", () => {
    const prompt = buildSystemPrompt({
      ...BASE_CONFIG,
      business_hours: { timezone: "Asia/Kolkata", windows: [{ day: 1, open: "09:00", close: "17:00" }] },
    });
    expect(prompt).toMatch(/check_availability/);
    expect(prompt).toMatch(/list_upcoming_bookings/);
  });
});
