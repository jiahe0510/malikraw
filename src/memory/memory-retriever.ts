import { compileRelevantMemoryBlock } from "./memory-compiler.js";
import type {
  MemoryConfig,
  MemoryEmbedder,
  MemoryItemStore,
  MemoryRetrieveInput,
  RetrievedMemory,
  SessionStateStore,
  ToolChainMemoryStore,
} from "./types.js";

export class MemoryRetriever {
  constructor(
    private readonly sessionStore: SessionStateStore,
    private readonly memoryItemStore: MemoryItemStore,
    private readonly toolChainStore: ToolChainMemoryStore,
    private readonly config: MemoryConfig,
    private readonly embedder?: MemoryEmbedder,
  ) {}

  async retrieve(input: MemoryRetrieveInput): Promise<RetrievedMemory> {
    const embedding = this.embedder ? await safeEmbed(this.embedder, input.query) : undefined;
    const [sessionState, memoryItems, toolChains] = await Promise.all([
      this.sessionStore.read(input.context),
      this.searchMemoryItems(input, embedding),
      this.searchToolChains(input),
    ]);

    const base = {
      sessionState,
      memoryItems,
      toolChains,
      observations: {
        memoryItemsWritten: 0,
        toolChainsWritten: 0,
        memoryItemsRetrieved: memoryItems.length,
        toolChainsRetrieved: toolChains.length,
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

  private async searchMemoryItems(input: MemoryRetrieveInput, embedding: number[] | undefined) {
    console.log(
      `[memory:items:search:start] user=${input.context.userId} agent=${input.context.agentId} session=${input.context.sessionId} project=${input.context.projectId ?? "-"} limit=${this.config.episodicTopK} query=${JSON.stringify(truncate(input.query, 400))}`,
    );
    console.log(
      `[memory:items:search:embedding] user=${input.context.userId} agent=${input.context.agentId} session=${input.context.sessionId} enabled=${Boolean(this.embedder)} present=${Boolean(embedding)} dims=${embedding?.length ?? 0} preview=${formatEmbeddingPreview(embedding)}`,
    );

    const memoryItems = await this.memoryItemStore.searchRelevant(input.context, input.query, {
      limit: this.config.episodicTopK,
      embedding,
    });

    console.log(
      `[memory:items:search:result] user=${input.context.userId} agent=${input.context.agentId} session=${input.context.sessionId} count=${memoryItems.length} summaries=${JSON.stringify(memoryItems.map((item) => truncate(item.summary, 160)))}`,
    );

    return memoryItems;
  }

  private async searchToolChains(input: MemoryRetrieveInput) {
    const limit = Math.min(3, this.config.episodicTopK);
    const embedding = this.embedder ? await safeEmbed(this.embedder, input.query) : undefined;
    const toolChains = await this.toolChainStore.searchRelevant(input.context, input.query, { limit, embedding });
    console.log(
      `[memory:tool-chain:search:result] user=${input.context.userId} agent=${input.context.agentId} session=${input.context.sessionId} count=${toolChains.length} queries=${JSON.stringify(toolChains.map((item) => truncate(item.query, 120)))}`,
    );
    return toolChains;
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
