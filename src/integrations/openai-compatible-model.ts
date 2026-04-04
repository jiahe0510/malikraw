import type {
  AgentMessage,
  AgentModel,
  AgentModelRequest,
  ModelToolCall,
  ModelTurnResponse,
} from "../core/agent/types.js";
import type { OpenAICompatibleConfig } from "../core/config/agent-config.js";
import { normalizeMessagesForProfile, type TransportMessage } from "../core/providers/index.js";

type OpenAIChatCompletionRequest = {
  model: string;
  messages: TransportMessage[];
  tools?: Array<Record<string, unknown>>;
  tool_choice?: "auto";
  temperature?: number;
  max_tokens?: number;
};

type OpenAIChatCompletionResponse = {
  choices: Array<{
    message: {
      content?: string | null;
      tool_calls?: Array<{
        id: string;
        type: "function";
        function: {
          name: string;
          arguments: string;
        };
      }>;
    };
  }>;
};

export class ModelRequestError extends Error {
  readonly status: number;
  readonly responseBody: string;
  readonly contextLengthExceeded: boolean;

  constructor(input: {
    status: number;
    responseBody: string;
    contextLengthExceeded: boolean;
  }) {
    super(`Model request failed with ${input.status}: ${input.responseBody}`);
    this.name = "ModelRequestError";
    this.status = input.status;
    this.responseBody = input.responseBody;
    this.contextLengthExceeded = input.contextLengthExceeded;
  }
}

export class OpenAICompatibleModel implements AgentModel {
  constructor(private readonly config: OpenAICompatibleConfig) {}

  async generate(input: AgentModelRequest): Promise<ModelTurnResponse> {
    const requestBody = buildRequestBody(this.config, input);
    if (input.debug) {
      console.error("[model-request]");
      console.error(JSON.stringify(requestBody, null, 2));
    }

    const response = await fetch(buildChatCompletionsUrl(this.config.baseURL), {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${this.config.apiKey}`,
      },
      body: JSON.stringify(requestBody),
    });

    if (!response.ok) {
      const body = await response.text();
      throw new ModelRequestError({
        status: response.status,
        responseBody: body,
        contextLengthExceeded: looksLikeContextLengthFailure(response.status, body),
      });
    }

    const payload = await response.json() as OpenAIChatCompletionResponse;
    if (input.debug) {
      console.error("[model-response]");
      console.error(JSON.stringify(payload, null, 2));
    }
    const choice = payload.choices[0];
    if (!choice) {
      throw new Error("Model response did not include any choices.");
    }

    const message = choice.message;
    const toolCalls = message.tool_calls ?? [];

    if (toolCalls.length > 0) {
      return {
        type: "tool_calls",
        assistantMessage: normalizeAssistantContent(message.content),
        toolCalls: toolCalls.map(parseToolCall),
      };
    }

    return {
      type: "final",
      outputText: normalizeAssistantContent(message.content),
    };
  }
}

function buildRequestBody(config: OpenAICompatibleConfig, input: AgentModelRequest): OpenAIChatCompletionRequest {
  return {
    model: config.model,
    messages: normalizeMessagesForProfile(input.messages, config.profile),
    tools: input.tools,
    tool_choice: input.tools.length > 0 ? "auto" : undefined,
    temperature: config.temperature,
    max_tokens: config.maxTokens,
  };
}

function parseToolCall(toolCall: NonNullable<OpenAIChatCompletionResponse["choices"][number]["message"]["tool_calls"]>[number]): ModelToolCall {
  return {
    id: toolCall.id,
    name: toolCall.function.name,
    input: parseJson(toolCall.function.arguments),
  };
}

function parseJson(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch (error) {
    throw new Error(`Failed to parse tool arguments: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function normalizeAssistantContent(content: string | null | undefined): string {
  return stripPlanningPreamble(stripThinkBlocks(content ?? "")).trim();
}

function buildChatCompletionsUrl(baseURL: string): string {
  return `${baseURL.replace(/\/+$/, "")}/chat/completions`;
}

function looksLikeContextLengthFailure(status: number, body: string): boolean {
  if (status !== 400 && status !== 413 && status !== 422) {
    return false;
  }

  const normalized = body.toLowerCase();
  return [
    "maximum context length",
    "context length exceeded",
    "context window",
    "prompt is too long",
    "too many tokens",
  ].some((pattern) => normalized.includes(pattern));
}

function stripThinkBlocks(content: string): string {
  return content.replace(/<think>[\s\S]*?<\/think>/gi, "").trim();
}

function stripPlanningPreamble(content: string): string {
  const paragraphs = content
    .split(/\n\s*\n/)
    .map((paragraph) => paragraph.trim())
    .filter(Boolean);

  if (paragraphs.length === 0) {
    return "";
  }

  const filtered = [...paragraphs];
  while (filtered.length > 1 && looksLikePlanningPreamble(filtered[0] ?? "")) {
    filtered.shift();
  }

  return filtered.join("\n\n");
}

function looksLikePlanningPreamble(paragraph: string): boolean {
  const normalized = paragraph.trim().toLowerCase();
  if (!normalized) {
    return false;
  }

  return [
    /^we need to\b/,
    /^i need to\b/,
    /^need to\b/,
    /^we should\b/,
    /^i should\b/,
    /^let'?s\b/,
    /^we have\b/,
    /^the user\b/,
    /^user (wants|asked|is asking|needs)\b/,
    /^first[, ]/,
  ].some((pattern) => pattern.test(normalized))
    || (normalized.includes("system context") && normalized.includes("user"));
}
