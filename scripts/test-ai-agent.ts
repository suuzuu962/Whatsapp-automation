/**
 * Manual, no-UI smoke test for the AI agent pipeline (src/lib/ai/agent.ts).
 *
 * What it does, end to end, using your real Supabase project and real
 * AI provider key(s) — no browser, no dev server required:
 *   1. Creates (or reuses) one test auth user + account.
 *   2. Seeds a minimal ai_agent_config (business hours wide open, one
 *      service) so booking tools are exercisable, in ai_suggestion_only
 *      mode so the reply is always readable from `ai_draft_replies`
 *      regardless of whether WhatsApp is configured.
 *   3. Seeds one test contact + conversation.
 *   4. Sends two sample inbound messages through the REAL runAiAgent()
 *      function — an FAQ question, then a booking request — and prints
 *      what the model actually said, which tools it called, and any
 *      guardrail events logged.
 *
 * Usage:
 *   npx tsx scripts/test-ai-agent.ts
 *
 * Optional env vars (set in .env.local or inline):
 *   TEST_USER_EMAIL / TEST_USER_PASSWORD  — reused on repeat runs (default: ai-test@example.local / TestPassword123!)
 *   WHATSAPP_PHONE_NUMBER_ID / WHATSAPP_ACCESS_TOKEN — if both set, also
 *     seeds whatsapp_config with your real Meta credentials and flips
 *     the conversation to ai_active, so the SECOND run actually sends a
 *     real WhatsApp message to TEST_CONTACT_PHONE. Omit to stay fully
 *     offline (draft-only, nothing sent anywhere).
 *   TEST_CONTACT_PHONE — E.164 number to address the test contact as
 *     (only matters if you set the WhatsApp vars above). Default is a
 *     fake number, safe with no WhatsApp config set.
 */

import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";

// ---- 1. Load .env.local into process.env before anything else imports
// modules that read env vars at module scope (e.g. the encryption key). ----
function loadEnvLocal() {
  const path = resolve(process.cwd(), ".env.local");
  if (!existsSync(path)) {
    console.error(".env.local not found — create it first (see .env.local.example).");
    process.exit(1);
  }
  for (const line of readFileSync(path, "utf8").split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (!(key in process.env)) process.env[key] = value;
  }
}
loadEnvLocal();

const REQUIRED = ["NEXT_PUBLIC_SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY"];
const missing = REQUIRED.filter((k) => !process.env[k]);
if (missing.length > 0) {
  console.error(`Missing required env vars in .env.local: ${missing.join(", ")}`);
  process.exit(1);
}
if (!process.env.ANTHROPIC_API_KEY && !process.env.OPENAI_API_KEY) {
  console.error("Set ANTHROPIC_API_KEY or OPENAI_API_KEY in .env.local first.");
  process.exit(1);
}

async function main() {
  // Dynamic imports — deliberately after loadEnvLocal() so every module
  // that reads process.env at load time (encryption.ts, admin-client.ts)
  // sees the values.
  const { createClient } = await import("@supabase/supabase-js");
  const { runAiAgent } = await import("../src/lib/ai/agent");
  const { encrypt } = await import("../src/lib/whatsapp/encryption");

  const admin = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
  );

  const email = process.env.TEST_USER_EMAIL || "ai-test@example.local";
  const password = process.env.TEST_USER_PASSWORD || "TestPassword123!";
  const testPhone = process.env.TEST_CONTACT_PHONE || "15550001111";
  const hasRealWhatsApp = Boolean(
    process.env.WHATSAPP_PHONE_NUMBER_ID && process.env.WHATSAPP_ACCESS_TOKEN,
  );

  console.log(`\n== 1. Test account (${email}) ==`);
  let userId: string;
  const { data: existingUsers } = await admin.auth.admin.listUsers();
  const existing = existingUsers?.users.find((u) => u.email === email);
  if (existing) {
    userId = existing.id;
    console.log(`Reusing existing user ${userId}`);
  } else {
    const { data: created, error: createErr } = await admin.auth.admin.createUser({
      email,
      password,
      email_confirm: true,
    });
    if (createErr || !created.user) {
      throw new Error(`Failed to create test user: ${createErr?.message}`);
    }
    userId = created.user.id;
    console.log(`Created user ${userId}`);
    // Give the signup trigger a moment to create profiles/accounts rows.
    await new Promise((r) => setTimeout(r, 1500));
  }

  const { data: profile, error: profileErr } = await admin
    .from("profiles")
    .select("account_id")
    .eq("user_id", userId)
    .maybeSingle();
  if (profileErr || !profile?.account_id) {
    throw new Error(
      `No account found for test user — is the signup trigger installed? (${profileErr?.message ?? "no profile row"})`,
    );
  }
  const accountId = profile.account_id as string;
  console.log(`Account: ${accountId}`);

  console.log("\n== 2. AI agent config ==");
  const allWindows = Array.from({ length: 7 }, (_, day) => ({
    day,
    open: "00:00",
    close: "23:59",
  }));
  await admin
    .from("ai_agent_config")
    .upsert(
      {
        account_id: accountId,
        enabled: true,
        business_profile: {
          name: "Test Clinic",
          type: "clinic",
          description: "a test business seeded by scripts/test-ai-agent.ts",
        },
        agent_persona: { name: "Aria", tone: "warm and professional" },
        services: [{ name: "Consultation", price: "$50", duration_minutes: 30 }],
        business_hours: { timezone: "UTC", windows: allWindows },
        faqs: [{ question: "Do you accept walk-ins?", answer: "Yes, subject to availability." }],
        escalation_rules: [],
        restricted_topics: [],
        provider_priority: [],
        consequential_action_mode: "auto",
        default_appointment_duration_minutes: 30,
        appointment_reminder_offsets_minutes: [1440, 120],
        reminder_template_language: "en_US",
      },
      { onConflict: "account_id" },
    )
    .throwOnError();
  console.log("Business hours: open all week (00:00-23:59 UTC) so booking tools are easy to trigger.");

  if (hasRealWhatsApp) {
    console.log("\n== 2b. WhatsApp config (real credentials provided) ==");
    await admin
      .from("whatsapp_config")
      .upsert(
        {
          user_id: userId,
          account_id: accountId,
          phone_number_id: process.env.WHATSAPP_PHONE_NUMBER_ID,
          access_token: encrypt(process.env.WHATSAPP_ACCESS_TOKEN!),
          status: "connected",
          connected_at: new Date().toISOString(),
        },
        { onConflict: "user_id" },
      )
      .throwOnError();
    console.log(`Real WhatsApp send is ON — replies will be sent to ${testPhone}.`);
  } else {
    console.log(
      "\nNo WHATSAPP_PHONE_NUMBER_ID/WHATSAPP_ACCESS_TOKEN set — staying fully offline (nothing sent anywhere).",
    );
  }

  console.log("\n== 3. Test contact + conversation ==");
  const { data: contact } = await admin
    .from("contacts")
    .upsert(
      { user_id: userId, account_id: accountId, phone: testPhone, name: "Test Customer" },
      { onConflict: "user_id,phone" },
    )
    .select()
    .maybeSingle();
  let contactId = contact?.id as string | undefined;
  if (!contactId) {
    // No unique constraint to upsert against on a fresh table — fall back to find-or-create.
    const { data: found } = await admin
      .from("contacts")
      .select("id")
      .eq("account_id", accountId)
      .eq("phone", testPhone)
      .maybeSingle();
    if (found) {
      contactId = found.id as string;
    } else {
      const { data: inserted } = await admin
        .from("contacts")
        .insert({ user_id: userId, account_id: accountId, phone: testPhone, name: "Test Customer" })
        .select()
        .single();
      contactId = inserted!.id as string;
    }
  }
  console.log(`Contact: ${contactId}`);

  const { data: existingConvo } = await admin
    .from("conversations")
    .select("id")
    .eq("contact_id", contactId)
    .maybeSingle();
  let conversationId = existingConvo?.id as string | undefined;
  const mode = hasRealWhatsApp ? "ai_active" : "ai_suggestion_only";
  if (conversationId) {
    await admin.from("conversations").update({ mode, status: "open" }).eq("id", conversationId);
  } else {
    const { data: inserted } = await admin
      .from("conversations")
      .insert({ user_id: userId, account_id: accountId, contact_id: contactId, mode, status: "open" })
      .select()
      .single();
    conversationId = inserted!.id as string;
  }
  console.log(`Conversation: ${conversationId} (mode: ${mode})`);

  const messages = [
    "Hi, do you accept walk-ins?",
    "Actually, can you book me a Consultation for tomorrow at 10am?",
  ];

  for (const [i, text] of messages.entries()) {
    console.log(`\n== 4.${i + 1}. Sending: "${text}" ==`);
    await admin
      .from("messages")
      .insert({ conversation_id: conversationId, sender_type: "customer", content_type: "text", content_text: text })
      .throwOnError();

    const result = await runAiAgent({
      accountId,
      userId,
      contactId: contactId!,
      conversationId: conversationId!,
      inboundText: text,
    });
    console.log("runAiAgent() returned:", result);

    if (mode === "ai_suggestion_only") {
      const { data: draft } = await admin
        .from("ai_draft_replies")
        .select("content_text, tool_calls, status")
        .eq("conversation_id", conversationId)
        .order("created_at", { ascending: false })
        .limit(1)
        .maybeSingle();
      console.log("AI draft reply:", draft?.content_text ?? "(none — check ai_audit_log below)");
      if (draft?.tool_calls && (draft.tool_calls as unknown[]).length > 0) {
        console.log("Tool calls:", JSON.stringify(draft.tool_calls, null, 2));
      }
    } else {
      const { data: sent } = await admin
        .from("messages")
        .select("content_text")
        .eq("conversation_id", conversationId)
        .eq("sender_type", "bot")
        .order("created_at", { ascending: false })
        .limit(1)
        .maybeSingle();
      console.log("Sent reply:", sent?.content_text ?? "(none sent — check ai_audit_log below)");
    }

    const { data: audit } = await admin
      .from("ai_audit_log")
      .select("event_type, severity, detail")
      .eq("conversation_id", conversationId)
      .order("created_at", { ascending: false })
      .limit(5);
    if (audit && audit.length > 0) {
      console.log("Recent audit events:", JSON.stringify(audit, null, 2));
    }
  }

  console.log("\nDone. Re-run any time — the account/contact/conversation are reused.");
}

main().catch((err) => {
  console.error("\nFAILED:", err);
  process.exit(1);
});
