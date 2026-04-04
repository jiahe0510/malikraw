import type { OpenAICompatibleConfig } from "../core/config/agent-config.js";
import { recordRuntimeObservation } from "../core/observability/observability.js";
import { HeuristicEpisodeExtractor, LlmEpisodeExtractor } from "./extractors/episode-extractor.js";
import { OpenAIMemoryClient } from "./extractors/openai-memory-client.js";
import { FileBackedMemoryItemStore } from "./memory-item-store.js";
import { MemoryRetriever } from "./memory-retriever.js";
import { MemoryWriter } from "./memory-writer.js";
import { FileBackedSessionStateStore } from "./session-store.js";
import { FileBackedToolChainMemoryStore } from "./tool-chain-store.js";
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
      message: "Retrieved relevant memory for the current query.",
      data: {
        userId: input.context.userId,
        agentId: input.context.agentId,
        sessionId: input.context.sessionId,
        memoryItems: result.observations.memoryItemsRetrieved,
        toolChains: result.observations.toolChainsRetrieved,
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
      name: "memory.save",
      message: "Persisted memory artifacts for the completed turn.",
      data: {
        userId: input.context.userId,
        agentId: input.context.agentId,
        sessionId: input.context.sessionId,
        memoryItems: result.memoryItemsWritten,
        toolChains: result.toolChainsWritten,
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
  const memoryItemStore = new FileBackedMemoryItemStore();
  const toolChainStore = new FileBackedToolChainMemoryStore();

  const memoryClient = new OpenAIMemoryClient({
    baseURL: modelConfig.baseURL,
    apiKey: modelConfig.apiKey,
    model: modelConfig.model,
    profile: modelConfig.profile,
    temperature: 0,
  });
  const episodeExtractor = memoryClient
    ? new LlmEpisodeExtractor(memoryClient)
    : new HeuristicEpisodeExtractor();

  return new DefaultMemoryService(
    new MemoryRetriever(sessionStore, memoryItemStore, toolChainStore, modelConfig),
    new MemoryWriter(
      sessionStore,
      memoryItemStore,
      toolChainStore,
      episodeExtractor,
    ),
  );
}
