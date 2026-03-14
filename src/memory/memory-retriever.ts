import { compileRelevantMemoryBlock } from "./memory-compiler.js";
import type {
  EpisodicMemoryStore,
  MemoryConfig,
  MemoryEmbedder,
  MemoryRetrieveInput,
  RetrievedMemory,
  SemanticMemoryStore,
  SessionStateStore,
} from "./types.js";

export class MemoryRetriever {
  constructor(
    private readonly sessionStore: SessionStateStore,
    private readonly semanticStore: SemanticMemoryStore,
    private readonly episodicStore: EpisodicMemoryStore,
    private readonly config: MemoryConfig,
    private readonly embedder?: MemoryEmbedder,
  ) {}

  async retrieve(input: MemoryRetrieveInput): Promise<RetrievedMemory> {
    const [sessionState, semantic, episodes] = await Promise.all([
      this.sessionStore.read(input.context),
      this.semanticStore.listRelevant(input.context, ["session", "project", "global"], this.config.semanticTopK),
      this.searchEpisodes(input),
    ]);

    const base = {
      sessionState,
      semantic,
      episodes,
      observations: {
        semanticWritten: 0,
        episodesWritten: 0,
        semanticRetrieved: semantic.length,
        episodesRetrieved: episodes.length,
        compiledChars: 0,
        estimatedTokens: 0,
      },
    };
    const compiledBlock = compileRelevantMemoryBlock(base, this.config.maxPromptChars);
    const compiledChars = compiledBlock.length;

    return {
      ...base,
      compiledBlock,
      observations: {
        ...base.observations,
        compiledChars,
        estimatedTokens: estimateTokens(compiledChars),
      },
    };
  }

  private async searchEpisodes(input: MemoryRetrieveInput) {
    console.log(
      `[memory:episodes:search:start] user=${input.context.userId} agent=${input.context.agentId} session=${input.context.sessionId} project=${input.context.projectId ?? "-"} limit=${this.config.episodicTopK} query=${JSON.stringify(truncate(input.query, 400))}`,
    );

    const embedding = this.embedder ? await safeEmbed(this.embedder, input.query) : undefined;
    console.log(
      `[memory:episodes:search:embedding] user=${input.context.userId} agent=${input.context.agentId} session=${input.context.sessionId} enabled=${Boolean(this.embedder)} present=${Boolean(embedding)} dims=${embedding?.length ?? 0} preview=${formatEmbeddingPreview(embedding)}`,
    );

    const episodes = await this.episodicStore.searchRelevant(input.context, input.query, {
      limit: this.config.episodicTopK,
      embedding,
    });

    console.log(
      `[memory:episodes:search:result] user=${input.context.userId} agent=${input.context.agentId} session=${input.context.sessionId} count=${episodes.length} summaries=${JSON.stringify(episodes.map((episode) => truncate(episode.summary, 160)))}`,
    );

    return episodes;
  }
}

function estimateTokens(characters: number): number {
  return Math.ceil(characters / 4);
}

async function safeEmbed(embedder: MemoryEmbedder, text: string): Promise<number[] | undefined> {
  try {
    return await embedder.embed(text);
  } catch {
    return undefined;
  }
}

function formatEmbeddingPreview(embedding: number[] | undefined): string {
  if (!embedding || embedding.length === 0) {
    return "[]";
  }

  return JSON.stringify(embedding.slice(0, 8).map((value) => Number(value.toFixed(6))));
}

function truncate(value: string, maxLength: number): string {
  return value.length <= maxLength ? value : `${value.slice(0, maxLength)}...`;
}
