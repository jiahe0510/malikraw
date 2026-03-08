import type { TransportMessage } from "../../core/providers/index.js";
import type { EpisodeExtractor, EpisodicMemoryCandidate, MemoryWriteInput } from "../types.js";
import { OpenAIMemoryClient } from "./openai-memory-client.js";

type EpisodePayload = {
  episode?: {
    summary?: unknown;
    entities?: unknown;
    importance?: unknown;
    confidence?: unknown;
  };
};

export class HeuristicEpisodeExtractor implements EpisodeExtractor {
  async extract(input: MemoryWriteInput): Promise<EpisodicMemoryCandidate | undefined> {
    return extractEpisodeHeuristically(input);
  }
}

export class LlmEpisodeExtractor implements EpisodeExtractor {
  constructor(private readonly client: OpenAIMemoryClient) {}

  async extract(input: MemoryWriteInput): Promise<EpisodicMemoryCandidate | undefined> {
    if (!shouldExtractEpisode(input)) {
      return undefined;
    }

    try {
      const payload = await this.client.completeJson(buildEpisodePrompt(input));
      const normalized = normalizeEpisodePayload(payload);
      return normalized ?? extractEpisodeHeuristically(input);
    } catch {
      return extractEpisodeHeuristically(input);
    }
  }
}

export function shouldExtractEpisode(input: MemoryWriteInput): boolean {
  return input.toolResults.some((result) => result.ok)
    || /done|completed|finished|已完成|完成了|决策|决定/i.test(input.assistantResponse)
    || input.currentTaskState?.completedSteps.length !== undefined
      && input.currentTaskState.completedSteps.length > 0;
}

export function extractEpisodeHeuristically(input: MemoryWriteInput): EpisodicMemoryCandidate | undefined {
  if (!shouldExtractEpisode(input)) {
    return undefined;
  }

  const toolNames = input.toolResults
    .filter((result) => result.ok)
    .map((result) => result.toolName);
  const entities = [...new Set([
    ...extractCapitalizedTerms(input.userMessage),
    ...extractCapitalizedTerms(input.assistantResponse),
    ...toolNames,
  ])].slice(0, 8);

  return {
    summary: truncate(
      `Handled task "${input.userMessage}". Responded with "${input.assistantResponse}".${toolNames.length > 0 ? ` Used tools: ${toolNames.join(", ")}.` : ""}`,
      280,
    ),
    entities,
    importance: toolNames.length > 0 ? 0.8 : 0.6,
    confidence: 0.7,
  };
}

function buildEpisodePrompt(input: MemoryWriteInput): TransportMessage[] {
  return [{
    role: "system",
    content: [
      "Summarize the latest task turn into one compact episodic memory entry.",
      "Return strict JSON with shape {\"episode\": {\"summary\": string, \"entities\": string[], \"importance\": number, \"confidence\": number}}",
      "Focus on what was discussed, what decisions were made, and what outcome was produced.",
    ].join("\n"),
  }, {
    role: "user",
    content: JSON.stringify({
      userMessage: input.userMessage,
      assistantResponse: input.assistantResponse,
      toolResults: input.toolResults,
      taskState: input.currentTaskState,
    }),
  }];
}

function normalizeEpisodePayload(payload: unknown): EpisodicMemoryCandidate | undefined {
  const parsed = payload as EpisodePayload;
  const episode = parsed.episode;
  if (
    !episode
    || typeof episode.summary !== "string"
    || !Array.isArray(episode.entities)
    || typeof episode.importance !== "number"
  ) {
    return undefined;
  }

  return {
    summary: episode.summary,
    entities: episode.entities.filter((value): value is string => typeof value === "string").slice(0, 8),
    importance: episode.importance,
    confidence: typeof episode.confidence === "number" ? episode.confidence : 0.75,
  };
}

function extractCapitalizedTerms(value: string): string[] {
  return [...value.matchAll(/\b[A-Z][A-Za-z0-9_.-]+\b/g)].map((match) => match[0]);
}

function truncate(value: string, maxLength: number): string {
  return value.length <= maxLength ? value : `${value.slice(0, maxLength - 3)}...`;
}
