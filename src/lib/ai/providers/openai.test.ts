import { afterEach, describe, expect, it, vi } from "vitest";
import { createOpenAiProvider } from "./openai";
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

describe("openai provider — generateReply", () => {
  it("returns text when the response has no tool_calls", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(
          JSON.stringify({
            choices: [{ message: { role: "assistant", content: "Hi there!" } }],
          }),
          { status: 200 },
        ),
      ),
    );
    const provider = createOpenAiProvider("test-key");
    const result = await provider.generateReply({
      systemPrompt: "sys",
      history: [{ role: "user", content: "hello" }],
      tools: TOOLS,
    });
    expect(result).toEqual({ text: "Hi there!" });
  });

  it("returns normalized tool calls, parsing the stringified arguments", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(
          JSON.stringify({
            choices: [
              {
                message: {
                  role: "assistant",
                  content: null,
                  tool_calls: [
                    {
                      id: "call_1",
                      type: "function",
                      function: {
                        name: "update_customer",
                        arguments: JSON.stringify({ name: "Bob" }),
                      },
                    },
                  ],
                },
              },
            ],
          }),
          { status: 200 },
        ),
      ),
    );
    const provider = createOpenAiProvider("test-key");
    const result = await provider.generateReply({
      systemPrompt: "sys",
      history: [{ role: "user", content: "call me Bob" }],
      tools: TOOLS,
    });
    expect(result).toEqual({
      toolCalls: [{ id: "call_1", name: "update_customer", arguments: { name: "Bob" } }],
    });
  });

  it("treats malformed tool-call arguments as empty rather than crashing", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(
          JSON.stringify({
            choices: [
              {
                message: {
                  role: "assistant",
                  content: null,
                  tool_calls: [
                    {
                      id: "call_1",
                      type: "function",
                      function: { name: "get_customer_details", arguments: "{not json" },
                    },
                  ],
                },
              },
            ],
          }),
          { status: 200 },
        ),
      ),
    );
    const provider = createOpenAiProvider("test-key");
    const result = await provider.generateReply({
      systemPrompt: "sys",
      history: [],
      tools: TOOLS,
    });
    expect(result).toEqual({
      toolCalls: [{ id: "call_1", name: "get_customer_details", arguments: {} }],
    });
  });

  it("throws RecoverableProviderError on a 500 so the router can fall through", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("server error", { status: 500 })),
    );
    const provider = createOpenAiProvider("test-key");
    await expect(
      provider.generateReply({ systemPrompt: "sys", history: [], tools: TOOLS }),
    ).rejects.toBeInstanceOf(RecoverableProviderError);
  });
});

describe("openai provider — continueWithToolResults", () => {
  it("sends the assistant tool_calls + tool-role messages in the wire payload", async () => {
    let captured: Record<string, unknown> | null = null;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init: RequestInit) => {
        captured = JSON.parse(String(init.body));
        return new Response(
          JSON.stringify({
            choices: [{ message: { role: "assistant", content: "You are Bob." } }],
          }),
          { status: 200 },
        );
      }),
    );
    const provider = createOpenAiProvider("test-key");
    const result = await provider.continueWithToolResults({
      systemPrompt: "sys",
      history: [{ role: "user", content: "what's my name" }],
      tools: TOOLS,
      priorToolCalls: [
        { id: "call_1", name: "get_customer_details", arguments: {} },
      ],
      toolResults: [{ toolCallId: "call_1", result: { name: "Bob" } }],
    });

    expect(result).toEqual({ text: "You are Bob." });
    const messages = (captured as unknown as { messages: Record<string, unknown>[] })
      .messages;
    // system, user history, assistant tool_calls, tool result
    expect(messages).toHaveLength(4);
    expect(messages[2]).toEqual({
      role: "assistant",
      content: null,
      tool_calls: [
        {
          id: "call_1",
          type: "function",
          function: { name: "get_customer_details", arguments: "{}" },
        },
      ],
    });
    expect(messages[3]).toEqual({
      role: "tool",
      tool_call_id: "call_1",
      content: JSON.stringify({ name: "Bob" }),
    });
  });
});
