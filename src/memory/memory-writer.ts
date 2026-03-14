import type {
  EpisodeExtractor,
  MemoryConfig,
  MemoryWriteInput,
  MemoryWriteResult,
  SemanticExtractor,
  SessionStateRecord,
  SessionStateStore,
  SemanticMemoryStore,
  EpisodicMemoryStore,
  MemoryEmbedder,
  SessionTaskState,
} from "./types.js";

export class MemoryWriter {
  constructor(
    private readonly sessionStore: SessionStateStore,
    private readonly semanticStore: SemanticMemoryStore,
    private readonly episodicStore: EpisodicMemoryStore,
    private readonly semanticExtractor: SemanticExtractor,
    private readonly episodeExtractor: EpisodeExtractor,
    private readonly config: MemoryConfig,
    private readonly embedder?: MemoryEmbedder,
  ) {}

  async write(input: MemoryWriteInput): Promise<MemoryWriteResult> {
    const sessionState = buildSessionState(input, this.config.sessionRecentMessages);
    await this.sessionStore.write(sessionState);

    const semantic = await this.semanticExtractor.extract(input);
    const filteredSemantic = semantic.filter((item) => item.confidence >= this.config.importanceThreshold);
    const semanticWritten = filteredSemantic.length > 0
      ? await this.semanticStore.upsertMany(input.context, filteredSemantic)
      : 0;

    const episode = await this.episodeExtractor.extract(input);
    let episodeWritten = false;
    if (episode && episode.importance >= this.config.importanceThreshold) {
      const embedding = this.embedder ? await safeEmbed(this.embedder, episode.summary) : undefined;
      await this.episodicStore.insert(input.context, episode, embedding);
      episodeWritten = true;
    }

    if (input.compaction?.summary.trim()) {
      const compactionEpisode = {
        summary: input.compaction.summary.trim(),
        entities: ["compacted_history"],
        importance: Math.max(this.config.importanceThreshold, 0.85),
        confidence: 0.9,
        source: "history_compaction" as const,
        content: {
          kind: "history_compaction",
          messagesCompacted: input.compaction.messagesCompacted,
          estimatedTokens: input.compaction.estimatedTokens,
        },
      };
      const embedding = this.embedder ? await safeEmbed(this.embedder, compactionEpisode.summary) : undefined;
      await this.episodicStore.insert(input.context, compactionEpisode, embedding);
    }

    return {
      sessionState,
      semanticWritten,
      episodeWritten,
      observations: {
        semanticWritten,
        episodesWritten: episodeWritten ? 1 : 0,
        semanticRetrieved: 0,
        episodesRetrieved: 0,
        compiledChars: 0,
        estimatedTokens: 0,
      },
    };
  }
}

function buildSessionState(input: MemoryWriteInput, recentMessageLimit: number): SessionStateRecord {
  const now = new Date().toISOString();
  return {
    sessionId: input.context.sessionId,
    userId: input.context.userId,
    agentId: input.context.agentId,
    projectId: input.context.projectId,
    state: {
      recentMessages: input.sessionMessages.slice(-recentMessageLimit),
      taskState: input.currentTaskState ?? deriveTaskState(input, now),
    },
    updatedAt: now,
  };
}

function deriveTaskState(input: MemoryWriteInput, now: string): SessionTaskState {
  const completedSteps = input.toolResults
    .filter((result) => result.ok)
    .map((result) => `Executed ${result.toolName}`);
  const openQuestions = [...input.assistantResponse.matchAll(/([^?.!]*\?)/g)]
    .map((match) => match[1].trim())
    .filter(Boolean)
    .slice(0, 3);

  return {
    goal: input.userMessage,
    currentPlan: completedSteps.length > 0 ? [] : ["Clarify task and choose next action"],
    completedSteps,
    openQuestions,
    status: openQuestions.length > 0 ? "active" : "completed",
    updatedAt: now,
  };
}

async function safeEmbed(embedder: MemoryEmbedder, text: string): Promise<number[] | undefined> {
  try {
    return await embedder.embed(text);
  } catch {
    return undefined;
  }
}
