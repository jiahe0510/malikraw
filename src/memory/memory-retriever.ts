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
    const embedding = this.embedder ? await safeEmbed(this.embedder, input.query) : undefined;
    return this.episodicStore.searchRelevant(input.context, input.query, {
      limit: this.config.episodicTopK,
      embedding,
    });
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
