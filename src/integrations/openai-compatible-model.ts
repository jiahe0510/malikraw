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
      throw new Error(`Model request failed with ${response.status}: ${body}`);
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
  return content?.trim() || "";
}

function buildChatCompletionsUrl(baseURL: string): string {
  return `${baseURL.replace(/\/+$/, "")}/chat/completions`;
}
