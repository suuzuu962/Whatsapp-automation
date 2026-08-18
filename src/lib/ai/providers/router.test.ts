import { describe, expect, it, vi } from "vitest";
import { orderProviders, generateWithFallback } from "./router";
import { RecoverableProviderError, type LlmProvider } from "./types";

function stubProvider(name: string): LlmProvider {
  return {
    name,
    generateReply: vi.fn(),
    continueWithToolResults: vi.fn(),
  };
}

describe("orderProviders", () => {
  it("returns available providers unchanged when priority is empty", () => {
    const a = stubProvider("anthropic");
    const o = stubProvider("openai");
    expect(orderProviders([a, o], [])).toEqual([a, o]);
  });

  it("orders by the account's priority list", () => {
    const a = stubProvider("anthropic");
    const o = stubProvider("openai");
    expect(orderProviders([a, o], ["openai", "anthropic"])).toEqual([o, a]);
  });

  it("appends providers missing from a partial/stale priority list rather than dropping them", () => {
    const a = stubProvider("anthropic");
    const o = stubProvider("openai");
    // Priority only mentions a provider that isn't even configured —
    // both configured providers must still come back, not be silently
    // dropped.
    expect(orderProviders([a, o], ["gemini"])).toEqual([a, o]);
  });
});

describe("generateWithFallback", () => {
  it("throws immediately when no provider is configured", async () => {
    await expect(generateWithFallback([], vi.fn())).rejects.toThrow(
      /No AI provider configured/,
    );
  });

  it("returns the first provider's result when it succeeds", async () => {
    const a = stubProvider("anthropic");
    const o = stubProvider("openai");
    const result = await generateWithFallback([a, o], async (p) =>
      p.name === "anthropic" ? { text: "from anthropic" } : { text: "from openai" },
    );
    expect(result).toEqual({ text: "from anthropic" });
  });

  it("falls through to the next provider on a recoverable error", async () => {
    const a = stubProvider("anthropic");
    const o = stubProvider("openai");
    const result = await generateWithFallback([a, o], async (p) => {
      if (p.name === "anthropic") {
        throw new RecoverableProviderError("anthropic", "rate limited");
      }
      return { text: "from openai" };
    });
    expect(result).toEqual({ text: "from openai" });
  });

  it("does not fall through on a non-recoverable error", async () => {
    const a = stubProvider("anthropic");
    const o = stubProvider("openai");
    const call = vi.fn(async (p: LlmProvider) => {
      if (p.name === "anthropic") throw new Error("malformed request");
      return { text: "from openai" };
    });
    await expect(generateWithFallback([a, o], call)).rejects.toThrow(
      "malformed request",
    );
    // openai must never have been tried — the error wasn't recoverable.
    expect(call).toHaveBeenCalledTimes(1);
  });

  it("throws the last recoverable error once every provider is exhausted", async () => {
    const a = stubProvider("anthropic");
    const o = stubProvider("openai");
    const call = vi.fn(async (p: LlmProvider) => {
      throw new RecoverableProviderError(p.name, `${p.name} down`);
    });
    await expect(generateWithFallback([a, o], call)).rejects.toThrow(
      "openai down",
    );
  });
});
