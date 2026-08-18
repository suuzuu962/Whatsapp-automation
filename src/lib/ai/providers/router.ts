import { createAnthropicProvider } from "./anthropic";
import { createOpenAiProvider } from "./openai";
import {
  RecoverableProviderError,
  type GenerateReplyOutput,
  type LlmProvider,
} from "./types";

/**
 * Fallback-chain mechanism: try providers in order, and on a recoverable
 * error (timeout, rate limit, 5xx — see RecoverableProviderError) from
 * one, fall through to the next. Same retry-on-recoverable-error shape
 * as the phone-variant retry loop already used in
 * automations/meta-send.ts and flows/meta-send.ts.
 *
 * Adding a third/fourth provider (Gemini, OpenRouter, ...) later is a
 * matter of writing one more adapter file with the same LlmProvider
 * shape and listing its env var here — not a redesign of this module.
 */

export function buildAvailableProviders(): LlmProvider[] {
  const providers: LlmProvider[] = [];
  if (process.env.ANTHROPIC_API_KEY) {
    providers.push(createAnthropicProvider(process.env.ANTHROPIC_API_KEY));
  }
  if (process.env.OPENAI_API_KEY) {
    providers.push(createOpenAiProvider(process.env.OPENAI_API_KEY));
  }
  return providers;
}

/**
 * Orders `available` providers by the account's configured
 * `provider_priority` (e.g. ['anthropic', 'openai']). Providers the
 * account didn't mention are appended at the end rather than dropped —
 * a partial or stale priority list shouldn't silently remove a
 * configured provider from the fallback chain.
 */
export function orderProviders(
  available: LlmProvider[],
  priority: string[],
): LlmProvider[] {
  if (priority.length === 0) return available;
  const byName = new Map(available.map((p) => [p.name, p]));
  const ordered: LlmProvider[] = [];
  for (const name of priority) {
    const p = byName.get(name);
    if (p) ordered.push(p);
  }
  for (const p of available) {
    if (!ordered.includes(p)) ordered.push(p);
  }
  return ordered;
}

/**
 * Runs `call` against each provider in order, falling through on
 * RecoverableProviderError. Throws immediately on any other error (a
 * malformed request won't succeed on a different provider either) and
 * throws the last recoverable error if every provider was exhausted.
 */
export async function generateWithFallback(
  providers: LlmProvider[],
  call: (provider: LlmProvider) => Promise<GenerateReplyOutput>,
): Promise<GenerateReplyOutput> {
  if (providers.length === 0) {
    throw new Error(
      "No AI provider configured — set ANTHROPIC_API_KEY or OPENAI_API_KEY.",
    );
  }
  let lastErr: unknown;
  for (const provider of providers) {
    try {
      return await call(provider);
    } catch (err) {
      if (err instanceof RecoverableProviderError) {
        lastErr = err;
        continue;
      }
      throw err;
    }
  }
  throw lastErr instanceof Error
    ? lastErr
    : new Error("All configured AI providers failed");
}
