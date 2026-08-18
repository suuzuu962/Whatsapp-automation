import { afterEach, describe, expect, it, vi } from "vitest";
import { createAnthropicProvider } from "./anthropic";
import { RecoverableProviderError } from "./types";

afterEach(() => {
  vi.unstubAllGlobals();
});

const TOOLS = [
  {
    name: "get_customer_details",
    description: "Look up the current customer.",
    input_schema: { type: "object" as const, properties: {} },
  },
];

describe("anthropic provider — generateReply", () => {
  it("returns text when the response has no tool_use blocks", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(
          JSON.stringify({ content: [{ type: "text", text: "Hi there!" }] }),
          { status: 200 },
        ),
      ),
    );
    const provider = createAnthropicProvider("test-key");
    const result = await provider.generateReply({
      systemPrompt: "You are a helpful assistant.",
      history: [{ role: "user", content: "hello" }],
      tools: TOOLS,
    });
    expect(result).toEqual({ text: "Hi there!" });
  });

  it("returns normalized tool calls when the response has tool_use blocks", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(
          JSON.stringify({
            content: [
              {
                type: "tool_use",
                id: "toolu_123",
                name: "get_customer_details",
                input: {},
              },
            ],
          }),
          { status: 200 },
        ),
      ),
    );
    const provider = createAnthropicProvider("test-key");
    const result = await provider.generateReply({
      systemPrompt: "sys",
      history: [{ role: "user", content: "what's my info" }],
      tools: TOOLS,
    });
    expect(result).toEqual({
      toolCalls: [{ id: "toolu_123", name: "get_customer_details", arguments: {} }],
    });
  });

  it("throws RecoverableProviderError on a 429 so the router can fall through", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("rate limited", { status: 429 })),
    );
    const provider = createAnthropicProvider("test-key");
    await expect(
      provider.generateReply({ systemPrompt: "sys", history: [], tools: TOOLS }),
    ).rejects.toBeInstanceOf(RecoverableProviderError);
  });

  it("throws a plain error (not recoverable) on a 400", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("bad request", { status: 400 })),
    );
    const provider = createAnthropicProvider("test-key");
    await expect(
      provider.generateReply({ systemPrompt: "sys", history: [], tools: TOOLS }),
    ).rejects.not.toBeInstanceOf(RecoverableProviderError);
  });
});

describe("anthropic provider — continueWithToolResults", () => {
  it("sends the tool_use/tool_result round trip in the wire payload", async () => {
    let captured: Record<string, unknown> | null = null;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init: RequestInit) => {
        captured = JSON.parse(String(init.body));
        return new Response(
          JSON.stringify({ content: [{ type: "text", text: "You are Bob." }] }),
          { status: 200 },
        );
      }),
    );
    const provider = createAnthropicProvider("test-key");
    const result = await provider.continueWithToolResults({
      systemPrompt: "sys",
      history: [{ role: "user", content: "what's my name" }],
      tools: TOOLS,
      priorToolCalls: [
        { id: "toolu_123", name: "get_customer_details", arguments: {} },
      ],
      toolResults: [{ toolCallId: "toolu_123", result: { name: "Bob" } }],
    });

    expect(result).toEqual({ text: "You are Bob." });
    const messages = (captured as unknown as { messages: unknown[] }).messages;
    // user history, assistant tool_use, user tool_result
    expect(messages).toHaveLength(3);
    expect(messages[1]).toEqual({
      role: "assistant",
      content: [
        { type: "tool_use", id: "toolu_123", name: "get_customer_details", input: {} },
      ],
    });
    expect(messages[2]).toEqual({
      role: "user",
      content: [
        {
          type: "tool_result",
          tool_use_id: "toolu_123",
          content: JSON.stringify({ name: "Bob" }),
        },
      ],
    });
  });
});
