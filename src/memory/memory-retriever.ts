import { compileRelevantMemoryBlock } from "./memory-compiler.js";
import { recordRuntimeObservation } from "../core/observability/observability.js";
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
    recordRuntimeObservation({
      name: "memory.search.items.start",
      message: "Searching stored memory items.",
      data: {
        userId: input.context.userId,
        agentId: input.context.agentId,
        sessionId: input.context.sessionId,
        projectId: input.context.projectId ?? "-",
        limit: this.config.episodicTopK,
        query: truncate(input.query, 400),
      },
    });

    const memoryItems = await this.memoryItemStore.searchRelevant(input.context, input.query, {
      limit: this.config.episodicTopK,
    });

    recordRuntimeObservation({
      name: "memory.search.items.result",
      message: "Finished searching stored memory items.",
      data: {
        userId: input.context.userId,
        agentId: input.context.agentId,
        sessionId: input.context.sessionId,
        count: memoryItems.length,
        summaries: memoryItems.map((item) => truncate(item.summary, 160)),
      },
    });

    return memoryItems;
  }

  private async searchToolChains(input: MemoryRetrieveInput) {
    const limit = Math.min(3, this.config.episodicTopK);
    recordRuntimeObservation({
      name: "memory.search.tool_chain.start",
      message: "Searching reusable tool chains.",
      data: {
        userId: input.context.userId,
        agentId: input.context.agentId,
        sessionId: input.context.sessionId,
        limit,
        query: truncate(input.query, 400),
      },
    });
    const toolChains = await this.toolChainStore.searchRelevant(input.context, input.query, { limit });
    recordRuntimeObservation({
      name: "memory.search.tool_chain.result",
      message: "Finished searching reusable tool chains.",
      data: {
        userId: input.context.userId,
        agentId: input.context.agentId,
        sessionId: input.context.sessionId,
        count: toolChains.length,
        queries: toolChains.map((item) => truncate(item.query, 120)),
      },
    });
    return toolChains;
  }
}

function estimateTokens(characters: number): number {
  return Math.ceil(characters / 4);
}

function truncate(value: string, maxLength: number): string {
  return value.length <= maxLength ? value : `${value.slice(0, maxLength)}...`;
}
