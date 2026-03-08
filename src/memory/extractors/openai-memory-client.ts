import type { ProviderProfile } from "../../core/providers/compatibility-profile.js";
import { normalizeMessagesForProfile, type TransportMessage } from "../../core/providers/index.js";

type ChatCompletionConfig = {
  baseURL: string;
  apiKey: string;
  model: string;
  profile?: ProviderProfile;
  temperature?: number;
};

type OpenAIChatCompletionResponse = {
  choices?: Array<{
    message?: {
      content?: string | null;
    };
  }>;
};

export class OpenAIMemoryClient {
  constructor(private readonly config: ChatCompletionConfig) {}

  async completeJson(messages: TransportMessage[]): Promise<unknown> {
    const response = await fetch(`${this.config.baseURL.replace(/\/+$/, "")}/chat/completions`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${this.config.apiKey}`,
      },
      body: JSON.stringify({
        model: this.config.model,
        messages: normalizeMessagesForProfile(messages, this.config.profile),
        temperature: this.config.temperature ?? 0,
      }),
    });

    if (!response.ok) {
      throw new Error(`Memory extraction request failed with ${response.status}: ${await response.text()}`);
    }

    const payload = await response.json() as OpenAIChatCompletionResponse;
    const content = payload.choices?.[0]?.message?.content?.trim();
    if (!content) {
      throw new Error("Memory extraction response was empty.");
    }

    return parseJsonFromContent(content);
  }
}

function parseJsonFromContent(content: string): unknown {
  const fenced = content.match(/```json\s*([\s\S]*?)```/i)?.[1];
  const candidate = fenced ?? content;
  return JSON.parse(candidate);
}
