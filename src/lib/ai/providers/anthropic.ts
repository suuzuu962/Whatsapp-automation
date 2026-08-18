import {
  RecoverableProviderError,
  type ChatMessage,
  type ContinueWithToolResultsInput,
  type GenerateReplyInput,
  type GenerateReplyOutput,
  type LlmProvider,
  type NormalizedToolCall,
  type ToolSchema,
} from "./types";

const API_URL = "https://api.anthropic.com/v1/messages";
const ANTHROPIC_VERSION = "2023-06-01";
const DEFAULT_MODEL = "claude-sonnet-5";
const MAX_TOKENS = 1024;

type AnthropicContentBlock =
  | { type: "text"; text: string }
  | { type: "tool_use"; id: string; name: string; input: Record<string, unknown> }
  | { type: "tool_result"; tool_use_id: string; content: string };

interface AnthropicMessage {
  role: "user" | "assistant";
  content: string | AnthropicContentBlock[];
}

function toWireTools(tools: ToolSchema[]) {
  return tools.map((t) => ({
    name: t.name,
    description: t.description,
    input_schema: t.input_schema,
  }));
}

function toWireHistory(history: ChatMessage[]): AnthropicMessage[] {
  return history.map((m) => ({ role: m.role, content: m.content }));
}

async function callMessages(
  apiKey: string,
  body: Record<string, unknown>,
): Promise<GenerateReplyOutput> {
  let res: Response;
  try {
    res = await fetch(API_URL, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": ANTHROPIC_VERSION,
      },
      body: JSON.stringify(body),
    });
  } catch (err) {
    // Network failure — treat as recoverable so the router tries the
    // next configured provider.
    throw new RecoverableProviderError(
      "anthropic",
      err instanceof Error ? err.message : String(err),
    );
  }

  if (res.status === 429 || res.status >= 500) {
    throw new RecoverableProviderError(
      "anthropic",
      `Anthropic returned ${res.status}`,
    );
  }
  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new Error(`Anthropic request failed (${res.status}): ${detail}`);
  }

  const json = (await res.json()) as { content: AnthropicContentBlock[] };
  const textBlocks = json.content.filter(
    (b): b is Extract<AnthropicContentBlock, { type: "text" }> =>
      b.type === "text",
  );
  const toolUseBlocks = json.content.filter(
    (b): b is Extract<AnthropicContentBlock, { type: "tool_use" }> =>
      b.type === "tool_use",
  );

  if (toolUseBlocks.length > 0) {
    const toolCalls: NormalizedToolCall[] = toolUseBlocks.map((b) => ({
      id: b.id,
      name: b.name,
      arguments: b.input,
    }));
    return { toolCalls };
  }
  return { text: textBlocks.map((b) => b.text).join("\n").trim() };
}

export function createAnthropicProvider(
  apiKey: string,
  model = DEFAULT_MODEL,
): LlmProvider {
  return {
    name: "anthropic",

    async generateReply(input: GenerateReplyInput): Promise<GenerateReplyOutput> {
      return callMessages(apiKey, {
        model,
        max_tokens: MAX_TOKENS,
        system: input.systemPrompt,
        messages: toWireHistory(input.history),
        tools: toWireTools(input.tools),
      });
    },

    async continueWithToolResults(
      input: ContinueWithToolResultsInput,
    ): Promise<GenerateReplyOutput> {
      const assistantToolUseMessage: AnthropicMessage = {
        role: "assistant",
        content: input.priorToolCalls.map((c) => ({
          type: "tool_use" as const,
          id: c.id,
          name: c.name,
          input: c.arguments,
        })),
      };
      const userToolResultMessage: AnthropicMessage = {
        role: "user",
        content: input.toolResults.map((r) => ({
          type: "tool_result" as const,
          tool_use_id: r.toolCallId,
          content:
            typeof r.result === "string" ? r.result : JSON.stringify(r.result),
        })),
      };
      return callMessages(apiKey, {
        model,
        max_tokens: MAX_TOKENS,
        system: input.systemPrompt,
        messages: [
          ...toWireHistory(input.history),
          assistantToolUseMessage,
          userToolResultMessage,
        ],
        tools: toWireTools(input.tools),
      });
    },
  };
}
