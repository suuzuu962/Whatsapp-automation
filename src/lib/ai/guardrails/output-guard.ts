/**
 * Layer 3 guardrail — checked on the model's generated reply text right
 * before it would be sent or drafted, never before. Two independent
 * checks:
 *
 *   1. Secret-shaped tokens — a reply should never contain something
 *      that looks like an API key or reference one of our env vars by
 *      name, regardless of why the model produced it.
 *   2. Verbatim system-prompt echo — if the reply contains a long
 *      verbatim chunk of `generated_system_prompt`, the model is leaking
 *      its configuration (persona, FAQs, escalation rules — all business
 *      confidential) rather than answering the customer. A short
 *      coincidental overlap (a shared service name, say) won't trip
 *      this; `MIN_LEAK_CHUNK_LENGTH` requires a long, non-trivial line
 *      to match before it's treated as a leak.
 *
 * A blocked output is never sent as-is — agent.ts substitutes a generic
 * fallback and hands off to a human instead (see runAiAgent).
 */

export interface OutputCheckResult {
  blocked: boolean;
  reason?: string;
}

const SECRET_TOKEN_RE =
  /\b(ANTHROPIC_API_KEY|OPENAI_API_KEY|SUPABASE_SERVICE_ROLE_KEY)\b|\bsk-[a-zA-Z0-9]{10,}\b/i;

const MIN_LEAK_CHUNK_LENGTH = 40;

// Strips punctuation too, not just whitespace — a model paraphrasing
// away a trailing period or exclamation mark shouldn't dodge detection.
function normalize(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

export function checkOutputForLeak(replyText: string, systemPrompt: string): OutputCheckResult {
  if (SECRET_TOKEN_RE.test(replyText)) {
    return { blocked: true, reason: "reply referenced a secret/API-key-shaped token" };
  }

  const normalizedReply = normalize(replyText);
  // Split on newlines first, then sentence boundaries — a single prompt
  // line often bundles multiple sentences (see buildSystemPrompt), and a
  // leak of just one of them should still trip this check.
  const promptChunks = systemPrompt
    .split("\n")
    .flatMap((l) => l.split(/(?<=[.!?])\s+/))
    .map((c) => c.trim())
    .filter((c) => c.length >= MIN_LEAK_CHUNK_LENGTH);

  for (const chunk of promptChunks) {
    if (normalizedReply.includes(normalize(chunk))) {
      return { blocked: true, reason: "reply echoed a verbatim line from the system prompt" };
    }
  }

  return { blocked: false };
}

export const OUTPUT_BLOCKED_FALLBACK_TEXT =
  "Sorry, I'm having trouble putting that into words correctly — connecting you with our team.";
