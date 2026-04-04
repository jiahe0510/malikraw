import { compileRelevantMemoryBlock } from "./memory-compiler.js";
import type {
  MemoryConfig,
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
  ) {}

  async retrieve(input: MemoryRetrieveInput): Promise<RetrievedMemory> {
    const [sessionState, memoryItems, toolChains] = await Promise.all([
      this.sessionStore.read(input.context),
      this.searchMemoryItems(input),
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

  private async searchMemoryItems(input: MemoryRetrieveInput) {
    console.log(
      `[memory:items:search:start] user=${input.context.userId} agent=${input.context.agentId} session=${input.context.sessionId} project=${input.context.projectId ?? "-"} limit=${this.config.episodicTopK} query=${JSON.stringify(truncate(input.query, 400))}`,
    );

    const memoryItems = await this.memoryItemStore.searchRelevant(input.context, input.query, {
      limit: this.config.episodicTopK,
    });

    console.log(
      `[memory:items:search:result] user=${input.context.userId} agent=${input.context.agentId} session=${input.context.sessionId} count=${memoryItems.length} summaries=${JSON.stringify(memoryItems.map((item) => truncate(item.summary, 160)))}`,
    );

    return memoryItems;
  }

  private async searchToolChains(input: MemoryRetrieveInput) {
    const limit = Math.min(3, this.config.episodicTopK);
    const toolChains = await this.toolChainStore.searchRelevant(input.context, input.query, { limit });
    console.log(
      `[memory:tool-chain:search:result] user=${input.context.userId} agent=${input.context.agentId} session=${input.context.sessionId} count=${toolChains.length} queries=${JSON.stringify(toolChains.map((item) => truncate(item.query, 120)))}`,
    );
    return toolChains;
  }
}

function estimateTokens(characters: number): number {
  return Math.ceil(characters / 4);
}

function truncate(value: string, maxLength: number): string {
  return value.length <= maxLength ? value : `${value.slice(0, maxLength)}...`;
}
