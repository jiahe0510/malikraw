import type { OpenAICompatibleConfig } from "../core/config/agent-config.js";
import { recordRuntimeObservation } from "../core/observability/observability.js";
import { FileBackedArtifactStore } from "./artifact-store.js";
import { MemoryRetriever } from "./memory-retriever.js";
import { MemoryWriter } from "./memory-writer.js";
import { FileBackedSessionStateStore } from "./session-store.js";
import type { MemoryRetrieveInput, MemoryService, MemoryWriteInput } from "./types.js";

export class DefaultMemoryService implements MemoryService {
  constructor(
    private readonly retriever: MemoryRetriever,
    private readonly writer: MemoryWriter,
  ) {}

  async retrieve(input: MemoryRetrieveInput) {
    const result = await this.retriever.retrieve(input);
    recordRuntimeObservation({
      name: "memory.retrieve",
      message: "Retrieved relevant memory artifacts for the current query.",
      data: {
        traceId: input.context.traceId,
        userId: input.context.userId,
        agentId: input.context.agentId,
        sessionId: input.context.sessionId,
        mode: input.mode ?? "normal",
        knowledgeArtifacts: result.observations.knowledgeArtifactsRetrieved,
        proceduralArtifacts: result.observations.proceduralArtifactsRetrieved,
        compiledChars: result.observations.compiledChars,
        estimatedTokens: result.observations.estimatedTokens,
        query: input.query,
      },
    });
    return result;
  }

  async write(input: MemoryWriteInput) {
    const result = await this.writer.write(input);
    recordRuntimeObservation({
      name: "memory.artifacts.write",
      message: "Persisted memory artifacts for the completed turn.",
      data: {
        traceId: input.context.traceId,
        userId: input.context.userId,
        agentId: input.context.agentId,
        sessionId: input.context.sessionId,
        knowledgeArtifacts: result.knowledgeArtifactsWritten,
        proceduralArtifacts: result.proceduralArtifactsWritten,
      },
    });
    return result;
  }
}

export function createMemoryService(
  _config: unknown,
  modelConfig: OpenAICompatibleConfig,
): MemoryService {
  const sessionStore = new FileBackedSessionStateStore();
  const artifactStore = new FileBackedArtifactStore();

  return new DefaultMemoryService(
    new MemoryRetriever(sessionStore, artifactStore, modelConfig),
    new MemoryWriter(
      sessionStore,
      artifactStore,
    ),
  );
}
