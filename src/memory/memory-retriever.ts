import { compileRelevantMemoryBlock } from "./memory-compiler.js";
import { recordRuntimeObservation } from "../core/observability/observability.js";
import type { OpenAICompatibleConfig } from "../core/config/agent-config.js";
import type {
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
    private readonly modelConfig: OpenAICompatibleConfig,
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
    const compiledBlock = compileRelevantMemoryBlock(base, {
      query: input.query,
      contextWindow: this.modelConfig.contextWindow,
      maxTokens: this.modelConfig.maxTokens ?? 4096,
    });
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
      name: "memory.search.start",
      message: "Searching stored memory.",
      data: {
        userId: input.context.userId,
        agentId: input.context.agentId,
        sessionId: input.context.sessionId,
        projectId: input.context.projectId ?? "-",
        target: "memory_items",
        limit: 4,
        query: truncate(input.query, 400),
      },
    });

    const memoryItems = await this.memoryItemStore.searchRelevant(input.context, input.query, {
      limit: 4,
    });

    recordRuntimeObservation({
      name: "memory.search.result",
      message: "Finished searching stored memory.",
      data: {
        userId: input.context.userId,
        agentId: input.context.agentId,
        sessionId: input.context.sessionId,
        target: "memory_items",
        count: memoryItems.length,
        summaries: memoryItems.map((item) => truncate(item.summary, 160)),
      },
    });

    return memoryItems;
  }

  private async searchToolChains(input: MemoryRetrieveInput) {
    const limit = 3;
    recordRuntimeObservation({
      name: "memory.search.start",
      message: "Searching stored memory.",
      data: {
        userId: input.context.userId,
        agentId: input.context.agentId,
        sessionId: input.context.sessionId,
        target: "tool_chains",
        limit,
        query: truncate(input.query, 400),
      },
    });
    const toolChains = await this.toolChainStore.searchRelevant(input.context, input.query, { limit });
    recordRuntimeObservation({
      name: "memory.search.result",
      message: "Finished searching stored memory.",
      data: {
        userId: input.context.userId,
        agentId: input.context.agentId,
        sessionId: input.context.sessionId,
        target: "tool_chains",
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
