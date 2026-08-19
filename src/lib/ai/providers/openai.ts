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

const API_URL = "https://api.openai.com/v1/chat/completions";
const DEFAULT_MODEL = "gpt-4o-mini";
const MAX_TOKENS = 1024;

interface OpenAiToolCallWire {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

interface OpenAiMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string | null;
  tool_calls?: OpenAiToolCallWire[];
  tool_call_id?: string;
}

function toWireTools(tools: ToolSchema[]) {
  return tools.map((t) => ({
    type: "function" as const,
    function: {
      name: t.name,
      description: t.description,
      parameters: t.input_schema,
    },
  }));
}

/** OpenAI's Chat Completions API rejects a request with `tools: []` —
 *  it must be omitted entirely when there are none (e.g. the wizard's
 *  extract-from-description call, which never uses tools), not just
 *  empty. `tool_choice` is invalid without `tools` for the same reason. */
function toolsWireFields(tools: ToolSchema[]): Record<string, unknown> {
  if (tools.length === 0) return {};
  return { tools: toWireTools(tools), tool_choice: "auto" };
}

function toWireHistory(history: ChatMessage[]): OpenAiMessage[] {
  return history.map((m) => ({ role: m.role, content: m.content }));
}

async function callChatCompletions(
  apiKey: string,
  body: Record<string, unknown>,
): Promise<GenerateReplyOutput> {
  let res: Response;
  try {
    res = await fetch(API_URL, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify(body),
    });
  } catch (err) {
    throw new RecoverableProviderError(
      "openai",
      err instanceof Error ? err.message : String(err),
    );
  }

  if (res.status === 429 || res.status >= 500) {
    throw new RecoverableProviderError("openai", `OpenAI returned ${res.status}`);
  }
  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new Error(`OpenAI request failed (${res.status}): ${detail}`);
  }

  const json = (await res.json()) as {
    choices: { message: OpenAiMessage }[];
  };
  const message = json.choices[0]?.message;
  if (!message) {
    throw new Error("OpenAI response had no choices");
  }

  if (message.tool_calls && message.tool_calls.length > 0) {
    const toolCalls: NormalizedToolCall[] = message.tool_calls.map((c) => {
      let args: Record<string, unknown> = {};
      try {
        args = JSON.parse(c.function.arguments || "{}");
      } catch {
        // Malformed JSON from the model — treat as no arguments rather
        // than crash the whole turn; the tool executor's own validation
        // will reject a call missing required fields.
        args = {};
      }
      return { id: c.id, name: c.function.name, arguments: args };
    });
    return { toolCalls };
  }
  return { text: (message.content ?? "").trim() };
}

export function createOpenAiProvider(
  apiKey: string,
  model = DEFAULT_MODEL,
): LlmProvider {
  return {
    name: "openai",

    async generateReply(input: GenerateReplyInput): Promise<GenerateReplyOutput> {
      return callChatCompletions(apiKey, {
        model,
        max_tokens: MAX_TOKENS,
        messages: [
          { role: "system", content: input.systemPrompt },
          ...toWireHistory(input.history),
        ],
        ...toolsWireFields(input.tools),
      });
    },

    async continueWithToolResults(
      input: ContinueWithToolResultsInput,
    ): Promise<GenerateReplyOutput> {
      const assistantToolCallMessage: OpenAiMessage = {
        role: "assistant",
        content: null,
        tool_calls: input.priorToolCalls.map((c) => ({
          id: c.id,
          type: "function" as const,
          function: { name: c.name, arguments: JSON.stringify(c.arguments) },
        })),
      };
      const toolResultMessages: OpenAiMessage[] = input.toolResults.map((r) => ({
        role: "tool",
        tool_call_id: r.toolCallId,
        content: typeof r.result === "string" ? r.result : JSON.stringify(r.result),
      }));
      return callChatCompletions(apiKey, {
        model,
        max_tokens: MAX_TOKENS,
        messages: [
          { role: "system", content: input.systemPrompt },
          ...toWireHistory(input.history),
          assistantToolCallMessage,
          ...toolResultMessages,
        ],
        ...toolsWireFields(input.tools),
      });
    },
  };
}
