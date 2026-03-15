import type { OpenAICompatibleConfig } from "../core/config/agent-config.js";
import { OpenAICompatibleEmbedder } from "./embedding-client.js";
import { PostgresEpisodicMemoryStore } from "./episodic-store.js";
import { HeuristicEpisodeExtractor, LlmEpisodeExtractor } from "./extractors/episode-extractor.js";
import { OpenAIMemoryClient } from "./extractors/openai-memory-client.js";
import { HeuristicSemanticExtractor, LlmSemanticExtractor } from "./extractors/semantic-extractor.js";
import { MemoryRetriever } from "./memory-retriever.js";
import { MemoryWriter } from "./memory-writer.js";
import { PostgresSemanticMemoryStore } from "./semantic-store.js";
import { RedisSessionStateStore } from "./session-store.js";
import { PostgresToolChainMemoryStore } from "./tool-chain-store.js";
import type { MemoryConfig, MemoryRetrieveInput, MemoryService, MemoryWriteInput } from "./types.js";

export class DefaultMemoryService implements MemoryService {
  constructor(
    private readonly retriever: MemoryRetriever,
    private readonly writer: MemoryWriter,
  ) {}

  async retrieve(input: MemoryRetrieveInput) {
    const result = await this.retriever.retrieve(input);
    console.log(
      `[memory:retrieve] user=${input.context.userId} agent=${input.context.agentId} session=${input.context.sessionId} semantic=${result.observations.semanticRetrieved} episodes=${result.observations.episodesRetrieved} chars=${result.observations.compiledChars} est_tokens=${result.observations.estimatedTokens}`,
    );
    return result;
  }

  async write(input: MemoryWriteInput) {
    const result = await this.writer.write(input);
    console.log(
      `[memory:write] user=${input.context.userId} agent=${input.context.agentId} session=${input.context.sessionId} semantic=${result.semanticWritten} episodes=${result.episodeWritten ? 1 : 0} tool_chains=${result.toolChainsWritten}`,
    );
    return result;
  }
}

export class NoopMemoryService implements MemoryService {
  async retrieve(input: MemoryRetrieveInput) {
    return {
      sessionState: undefined,
      semantic: [],
      episodes: [],
      compiledBlock: "",
      observations: {
        semanticWritten: 0,
        episodesWritten: 0,
        semanticRetrieved: 0,
        episodesRetrieved: 0,
        compiledChars: 0,
        estimatedTokens: 0,
      },
    };
  }

  async write(input: MemoryWriteInput) {
    return {
      sessionState: {
        sessionId: input.context.sessionId,
        userId: input.context.userId,
        agentId: input.context.agentId,
        projectId: input.context.projectId,
        state: {
          recentMessages: input.sessionMessages,
          taskState: input.currentTaskState ?? {
            currentPlan: [],
            completedSteps: [],
            openQuestions: [],
            status: "active",
            updatedAt: new Date().toISOString(),
          },
        },
        updatedAt: new Date().toISOString(),
      },
      semanticWritten: 0,
      episodeWritten: false,
      toolChainsWritten: 0,
      observations: {
        semanticWritten: 0,
        episodesWritten: 0,
        semanticRetrieved: 0,
        episodesRetrieved: 0,
        compiledChars: 0,
        estimatedTokens: 0,
      },
    };
  }
}

export function createMemoryService(
  config: MemoryConfig | undefined,
  modelConfig: OpenAICompatibleConfig,
): MemoryService {
  if (!config?.enabled) {
    return new NoopMemoryService();
  }

  const embedder = config.embeddingModel
    ? new OpenAICompatibleEmbedder({
      baseURL: modelConfig.baseURL,
      apiKey: modelConfig.apiKey,
      model: config.embeddingModel,
      profile: modelConfig.profile,
    })
    : undefined;
  const sessionStore = RedisSessionStateStore.fromUrl(config.redisUrl!);
  const semanticStore = PostgresSemanticMemoryStore.fromUrl(config.postgresUrl!);
  const episodicStore = PostgresEpisodicMemoryStore.fromUrl(config.postgresUrl!);
  const toolChainStore = PostgresToolChainMemoryStore.fromUrl(config.postgresUrl!);

  const memoryClient = new OpenAIMemoryClient({
    baseURL: modelConfig.baseURL,
    apiKey: modelConfig.apiKey,
    model: modelConfig.model,
    profile: modelConfig.profile,
    temperature: 0,
  });
  const semanticExtractor = memoryClient
    ? new LlmSemanticExtractor(memoryClient)
    : new HeuristicSemanticExtractor();
  const episodeExtractor = memoryClient
    ? new LlmEpisodeExtractor(memoryClient)
    : new HeuristicEpisodeExtractor();

  return new DefaultMemoryService(
    new MemoryRetriever(sessionStore, semanticStore, episodicStore, config, embedder),
    new MemoryWriter(
      sessionStore,
      semanticStore,
      episodicStore,
      toolChainStore,
      semanticExtractor,
      episodeExtractor,
      config,
      embedder,
    ),
  );
}
