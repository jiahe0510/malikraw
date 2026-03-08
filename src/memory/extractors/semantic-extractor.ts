import type { TransportMessage } from "../../core/providers/index.js";
import type { MemoryWriteInput, SemanticExtractor, SemanticMemoryCandidate } from "../types.js";
import { OpenAIMemoryClient } from "./openai-memory-client.js";

type ExtractedSemanticPayload = {
  semantic?: Array<{
    key?: unknown;
    value?: unknown;
    scope?: unknown;
    confidence?: unknown;
    source?: unknown;
    summary?: unknown;
  }>;
};

export class HeuristicSemanticExtractor implements SemanticExtractor {
  async extract(input: MemoryWriteInput): Promise<SemanticMemoryCandidate[]> {
    return extractSemanticHeuristically(input);
  }
}

export class LlmSemanticExtractor implements SemanticExtractor {
  constructor(private readonly client: OpenAIMemoryClient) {}

  async extract(input: MemoryWriteInput): Promise<SemanticMemoryCandidate[]> {
    if (!shouldExtractSemanticMemory(input)) {
      return [];
    }

    try {
      const payload = await this.client.completeJson(buildSemanticPrompt(input));
      const parsed = normalizeSemanticPayload(payload);
      return parsed.length > 0 ? parsed : extractSemanticHeuristically(input);
    } catch {
      return extractSemanticHeuristically(input);
    }
  }
}

export function shouldExtractSemanticMemory(input: MemoryWriteInput): boolean {
  const combined = `${input.userMessage}\n${input.assistantResponse}`.toLowerCase();
  return /prefer|always|never|must|use |tech stack|typescript|javascript|python|constraint|rule|喜欢|偏好|必须|不要|长期/.test(combined);
}

export function extractSemanticHeuristically(input: MemoryWriteInput): SemanticMemoryCandidate[] {
  const lines = input.userMessage
    .split(/\n+/)
    .map((line) => line.trim())
    .filter(Boolean);
  const facts: SemanticMemoryCandidate[] = [];

  for (const line of lines) {
    const preferenceMatch = line.match(/(?:i prefer|prefer|喜欢|偏好)\s+(.+)/i);
    if (preferenceMatch) {
      facts.push({
        key: "user_preference",
        value: preferenceMatch[1].trim(),
        scope: "global",
        confidence: 0.9,
        source: "explicit",
        summary: `User prefers ${preferenceMatch[1].trim()}.`,
      });
      continue;
    }

    const stackMatch = line.match(/(?:tech stack|use|使用)\s*:?\s*(typescript|javascript|python|go|rust)/i);
    if (stackMatch) {
      const value = stackMatch[1].trim();
      facts.push({
        key: "project_stack",
        value,
        scope: "project",
        confidence: 0.85,
        source: "explicit",
        summary: `Current project stack is ${value}.`,
      });
      continue;
    }

    const constraintMatch = line.match(/(?:must|need to|需要|必须|不要|禁止)\s*(?:保留|使用|采用|avoid|keep)?\s+(.+)/i);
    if (constraintMatch) {
      facts.push({
        key: slugify(constraintMatch[1]),
        value: constraintMatch[1].trim(),
        scope: "project",
        confidence: 0.75,
        source: "explicit",
        summary: `Project constraint: ${constraintMatch[1].trim()}.`,
      });
    }
  }

  return deduplicateSemantic(facts);
}

function buildSemanticPrompt(input: MemoryWriteInput): TransportMessage[] {
  return [{
    role: "system",
    content: [
      "Extract only durable semantic memory from the latest turn.",
      "Return strict JSON with shape {\"semantic\": [{\"key\": string, \"value\": string|boolean|number, \"scope\": \"session\"|\"project\"|\"global\", \"confidence\": number, \"source\": \"explicit\"|\"inferred\", \"summary\": string}]}",
      "Only include stable preferences, constraints, stack decisions, and long-lived rules.",
      "Do not include ephemeral tasks or transient chat details.",
    ].join("\n"),
  }, {
    role: "user",
    content: JSON.stringify({
      userMessage: input.userMessage,
      assistantResponse: input.assistantResponse,
      taskState: input.currentTaskState,
    }),
  }];
}

function normalizeSemanticPayload(payload: unknown): SemanticMemoryCandidate[] {
  const parsed = payload as ExtractedSemanticPayload;
  const candidates = parsed.semantic ?? [];
  return deduplicateSemantic(
    candidates.flatMap((item) => {
      if (
        typeof item.key !== "string"
        || (typeof item.value !== "string" && typeof item.value !== "boolean" && typeof item.value !== "number")
        || (item.scope !== "session" && item.scope !== "project" && item.scope !== "global")
        || typeof item.confidence !== "number"
        || (item.source !== "explicit" && item.source !== "inferred")
        || typeof item.summary !== "string"
      ) {
        return [];
      }

      return [{
        key: item.key,
        value: item.value,
        scope: item.scope,
        confidence: item.confidence,
        source: item.source,
        summary: item.summary,
      }];
    }),
  );
}

function deduplicateSemantic(items: SemanticMemoryCandidate[]): SemanticMemoryCandidate[] {
  const seen = new Map<string, SemanticMemoryCandidate>();
  for (const item of items) {
    const current = seen.get(item.key);
    if (!current || item.confidence >= current.confidence) {
      seen.set(item.key, item);
    }
  }

  return [...seen.values()];
}

function slugify(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 48) || "constraint";
}
