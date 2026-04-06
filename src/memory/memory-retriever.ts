import { compileRelevantMemoryBlock } from "./memory-compiler.js";
import { recordRuntimeObservation } from "../core/observability/observability.js";
import type { OpenAICompatibleConfig } from "../core/config/agent-config.js";
import type {
  ArtifactStore,
  KnowledgeArtifactRecord,
  MemoryRetrieveInput,
  MemoryRetrieveMode,
  ProceduralArtifactRecord,
  RetrievedMemory,
  SessionStateStore,
} from "./types.js";

export class MemoryRetriever {
  constructor(
    private readonly sessionStore: SessionStateStore,
    private readonly artifactStore: ArtifactStore,
    private readonly modelConfig: OpenAICompatibleConfig,
  ) {}

  async retrieve(input: MemoryRetrieveInput): Promise<RetrievedMemory> {
    const mode = input.mode ?? "normal";
    const [sessionState, knowledgeArtifacts, proceduralArtifacts] = await Promise.all([
      this.sessionStore.read(input.context),
      this.searchKnowledgeArtifacts(input, mode),
      this.searchProceduralArtifacts(input, mode),
    ]);

    const base = {
      sessionState,
      knowledgeArtifacts,
      proceduralArtifacts,
      observations: {
        knowledgeArtifactsWritten: 0,
        proceduralArtifactsWritten: 0,
        knowledgeArtifactsRetrieved: knowledgeArtifacts.length,
        proceduralArtifactsRetrieved: proceduralArtifacts.length,
        compiledChars: 0,
        estimatedTokens: 0,
      },
    };
    const compiledBlock = compileRelevantMemoryBlock(base, {
      query: input.query,
      mode,
      contextWindow: this.modelConfig.contextWindow,
      maxTokens: this.modelConfig.maxTokens ?? 4096,
    });
    const compiledChars = compiledBlock.length;

    return {
      ...base,
      compiledBlock,
      mode,
      observations: {
        ...base.observations,
        compiledChars,
        estimatedTokens: estimateTokens(compiledChars),
      },
    };
  }

  private async searchKnowledgeArtifacts(input: MemoryRetrieveInput, mode: MemoryRetrieveMode) {
    const limit = 6;
    recordRuntimeObservation({
      name: "memory.search.start",
      message: "Searching stored memory.",
      data: {
        traceId: input.context.traceId,
        userId: input.context.userId,
        agentId: input.context.agentId,
        sessionId: input.context.sessionId,
        projectId: input.context.projectId ?? "-",
        target: "knowledge_artifacts",
        mode,
        limit,
        query: truncate(input.query, 400),
      },
    });

    const candidates = await this.artifactStore.searchKnowledge(input.context, input.query, { limit });
    const knowledgeArtifacts = rerankKnowledgeArtifacts(candidates, input.query, mode).slice(0, 4);

    recordRuntimeObservation({
      name: "memory.search.result",
      message: "Finished searching stored memory.",
      data: {
        traceId: input.context.traceId,
        userId: input.context.userId,
        agentId: input.context.agentId,
        sessionId: input.context.sessionId,
        target: "memory_items",
        mode,
        count: knowledgeArtifacts.length,
        memoryTypes: knowledgeArtifacts.map((item) => item.memoryType ?? "semantic"),
        summaries: knowledgeArtifacts.map((item) => truncate(item.summary, 160)),
      },
    });

    return knowledgeArtifacts;
  }

  private async searchProceduralArtifacts(input: MemoryRetrieveInput, mode: MemoryRetrieveMode) {
    const limit = 4;
    recordRuntimeObservation({
      name: "memory.search.start",
      message: "Searching stored memory.",
      data: {
        traceId: input.context.traceId,
        userId: input.context.userId,
        agentId: input.context.agentId,
        sessionId: input.context.sessionId,
        target: "procedural_artifacts",
        mode,
        limit,
        query: truncate(input.query, 400),
      },
    });
    const candidates = await this.artifactStore.searchProcedural(input.context, input.query, { limit });
    const proceduralArtifacts = rerankProceduralArtifacts(candidates, input.query, mode).slice(0, 3);
    recordRuntimeObservation({
      name: "memory.search.result",
      message: "Finished searching stored memory.",
      data: {
        traceId: input.context.traceId,
        userId: input.context.userId,
        agentId: input.context.agentId,
        sessionId: input.context.sessionId,
        target: "tool_chains",
        mode,
        count: proceduralArtifacts.length,
        queries: proceduralArtifacts.map((item) => truncate(item.query, 120)),
      },
    });
    return proceduralArtifacts;
  }
}

function rerankKnowledgeArtifacts(
  records: KnowledgeArtifactRecord[],
  query: string,
  mode: MemoryRetrieveMode,
): KnowledgeArtifactRecord[] {
  const normalizedQuery = query.toLowerCase();
  return records
    .map((record) => ({
      record,
      score: scoreKnowledgeArtifact(record, normalizedQuery, mode),
    }))
    .sort((left, right) => right.score - left.score)
    .map(({ record }) => record);
}

function rerankProceduralArtifacts(
  records: ProceduralArtifactRecord[],
  query: string,
  mode: MemoryRetrieveMode,
): ProceduralArtifactRecord[] {
  const normalizedQuery = query.toLowerCase();
  return records
    .map((record) => ({
      record,
      score: scoreProceduralArtifact(record, normalizedQuery, mode),
    }))
    .sort((left, right) => right.score - left.score)
    .map(({ record }) => record);
}

function scoreKnowledgeArtifact(record: KnowledgeArtifactRecord, normalizedQuery: string, mode: MemoryRetrieveMode): number {
  const overlap = tokenOverlap(
    `${record.query} ${record.summary} ${record.content} ${(record.tags ?? []).join(" ")} ${(record.entities ?? []).join(" ")}`,
    normalizedQuery,
  );
  const memoryTypeBonus = (() => {
    switch (record.memoryType) {
      case "semantic":
        return 20;
      case "episodic":
        return 16;
      case "symptom":
        return mode === "analytic" ? 18 : 10;
      case "affective":
        return mode === "analytic" ? 14 : 8;
      case "repressed":
        return mode === "analytic" ? 2 : -14;
      default:
        return 6;
    }
  })();
  const salience = (record.salience ?? clamp01(record.importance)) * 18;
  const retrievalWeight = (record.retrievalWeight ?? clamp01(record.importance)) * 14;
  const confidence = (record.confidence ?? 0.5) * 8;
  const repressionPenalty = (record.repressionScore ?? 0) * (mode === "analytic" ? 8 : 24);
  const recency = recencyBoost(record.updatedAt ?? record.createdAt);
  const cueBonus = cueMatchBonus(record.triggerCues ?? [], normalizedQuery);
  return overlap * 12 + memoryTypeBonus + salience + retrievalWeight + confidence + recency + cueBonus - repressionPenalty;
}

function scoreProceduralArtifact(record: ProceduralArtifactRecord, normalizedQuery: string, mode: MemoryRetrieveMode): number {
  const overlap = tokenOverlap(
    `${record.query} ${record.assistantResponse} ${(record.tags ?? []).join(" ")} ${(record.entities ?? []).join(" ")} ${record.toolChain.map((step) => step.toolName).join(" ")}`,
    normalizedQuery,
  );
  const successfulSteps = record.toolChain.filter((step) => step.ok).length;
  const salience = (record.salience ?? clamp01(Math.min(1, successfulSteps / Math.max(1, record.toolChain.length)))) * 12;
  const retrievalWeight = (record.retrievalWeight ?? 0.7) * 14;
  const cueBonus = cueMatchBonus(record.triggerCues ?? [], normalizedQuery);
  const recency = recencyBoost(record.updatedAt ?? record.createdAt);
  return overlap * 10 + successfulSteps * 3 + salience + retrievalWeight + cueBonus + recency + (mode === "analytic" ? 1 : 0);
}

function tokenOverlap(haystackRaw: string, normalizedQuery: string): number {
  const haystack = haystackRaw.toLowerCase();
  return normalizedQuery
    .split(/\s+/)
    .filter(Boolean)
    .reduce((score, token) => score + (haystack.includes(token) ? 1 : 0), 0);
}

function cueMatchBonus(triggerCues: string[], normalizedQuery: string): number {
  if (triggerCues.length === 0) {
    return 0;
  }
  return triggerCues.reduce((score, cue) => score + (normalizedQuery.includes(cue.toLowerCase()) ? 4 : 0), 0);
}

function recencyBoost(isoDate: string | undefined): number {
  if (!isoDate) {
    return 0;
  }
  const deltaMs = Date.now() - Date.parse(isoDate);
  if (!Number.isFinite(deltaMs) || deltaMs < 0) {
    return 0;
  }
  const days = deltaMs / (1000 * 60 * 60 * 24);
  if (days < 1) {
    return 6;
  }
  if (days < 7) {
    return 4;
  }
  if (days < 30) {
    return 2;
  }
  return 0;
}

function estimateTokens(characters: number): number {
  return Math.ceil(characters / 4);
}

function truncate(value: string, maxLength: number): string {
  return value.length <= maxLength ? value : `${value.slice(0, maxLength)}...`;
}

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value));
}
