import type { ProviderProfile } from "../core/providers/compatibility-profile.js";

type EmbeddingConfig = {
  baseURL: string;
  apiKey: string;
  model: string;
  profile?: ProviderProfile;
};

type OpenAIEmbeddingsResponse = {
  data?: Array<{
    embedding?: number[];
  }>;
};

export class OpenAICompatibleEmbedder {
  constructor(private readonly config: EmbeddingConfig) {}

  async embed(input: string): Promise<number[]> {
    const response = await fetch(`${this.config.baseURL.replace(/\/+$/, "")}/embeddings`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${this.config.apiKey}`,
      },
      body: JSON.stringify({
        model: this.config.model,
        input,
      }),
    });

    if (!response.ok) {
      throw new Error(`Embedding request failed with ${response.status}: ${await response.text()}`);
    }

    const payload = await response.json() as OpenAIEmbeddingsResponse;
    const embedding = payload.data?.[0]?.embedding;
    if (!embedding || !Array.isArray(embedding)) {
      throw new Error("Embedding response did not include a vector.");
    }

    return embedding;
  }
}
