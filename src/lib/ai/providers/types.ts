/**
 * Provider-agnostic shapes for the AI reply engine's tool-calling loop.
 *
 * Each concrete adapter (anthropic.ts, openai.ts) translates to/from its
 * provider's own wire format — Claude's `tool_use`/`tool_result` content
 * blocks vs OpenAI's `tool_calls`/tool-role messages — so `agent.ts` never
 * has to know which provider actually answered. Adapters call the plain
 * Messages / Chat Completions HTTP API directly (no SDK, no
 * Assistants/Agents-platform features) — same "no dependency on a
 * hosted platform" rule the rest of this codebase already follows for
 * Meta's Graph API (see src/lib/whatsapp/meta-api.ts, which is also raw
 * fetch, no Facebook SDK).
 */

export interface ChatMessage {
  role: "user" | "assistant";
  content: string;
}

/**
 * A tool definition in JSON-Schema-subset form. `input_schema` follows
 * the plain `{ type: "object", properties: {...}, required: [...] }`
 * shape both Anthropic and OpenAI accept with only a wrapper-key
 * difference (see each adapter's `toWireTools`).
 */
export interface ToolSchema {
  name: string;
  description: string;
  input_schema: {
    type: "object";
    properties: Record<string, unknown>;
    required?: string[];
  };
}

export interface NormalizedToolCall {
  /** Provider-issued id — echoed back in the tool_result / tool message
   *  on the next turn so the provider can match results to calls. */
  id: string;
  name: string;
  arguments: Record<string, unknown>;
}

export interface ToolResultInput {
  toolCallId: string;
  /** JSON-serializable result, or an error string — the adapter stringifies
   *  either into the provider's expected tool-result content. */
  result: unknown;
}

export interface GenerateReplyInput {
  systemPrompt: string;
  history: ChatMessage[];
  tools: ToolSchema[];
}

export interface ContinueWithToolResultsInput {
  systemPrompt: string;
  history: ChatMessage[];
  tools: ToolSchema[];
  /** The assistant turn that requested these tool calls — adapters need
   *  it to reconstruct the provider-specific assistant message before
   *  appending the tool results. */
  priorToolCalls: NormalizedToolCall[];
  toolResults: ToolResultInput[];
}

export interface GenerateReplyOutput {
  /** Present when the model produced a final reply with no further tool
   *  calls pending. */
  text?: string;
  /** Present when the model wants to call one or more tools before it can
   *  produce a final reply. */
  toolCalls?: NormalizedToolCall[];
}

/**
 * Errors an adapter throws that the router should treat as "try the next
 * provider" rather than "fail the whole request" — timeouts, rate limits,
 * and 5xx responses. Anything else (e.g. a malformed request) propagates
 * immediately since retrying it on a different provider won't help.
 */
export class RecoverableProviderError extends Error {
  constructor(
    public readonly provider: string,
    message: string,
  ) {
    super(message);
    this.name = "RecoverableProviderError";
  }
}

export interface LlmProvider {
  /** Matches the keys used in ai_agent_config.provider_priority, e.g.
   *  "anthropic" | "openai". */
  name: string;
  generateReply(input: GenerateReplyInput): Promise<GenerateReplyOutput>;
  continueWithToolResults(
    input: ContinueWithToolResultsInput,
  ): Promise<GenerateReplyOutput>;
}
