import type {
  EpisodeExtractor,
  MemoryItemStore,
  MemoryWriteInput,
  MemoryWriteResult,
  SessionStateRecord,
  SessionStateStore,
  SessionTaskState,
  ToolChainMemoryStore,
  ToolChainStep,
} from "./types.js";

const MEMORY_IMPORTANCE_THRESHOLD = 0.65;

export class MemoryWriter {
  constructor(
    private readonly sessionStore: SessionStateStore,
    private readonly memoryItemStore: MemoryItemStore,
    private readonly toolChainStore: ToolChainMemoryStore,
    private readonly episodeExtractor: EpisodeExtractor,
  ) {}

  async write(input: MemoryWriteInput): Promise<MemoryWriteResult> {
    const sessionState = buildSessionState(input);
    await this.sessionStore.write(sessionState);

    const extracted = await this.episodeExtractor.extract(input);
    const content = buildMemoryItemContent(input, extracted?.summary);
    const importance = input.compaction?.summary
      ? Math.max(MEMORY_IMPORTANCE_THRESHOLD, 0.85)
      : extracted?.importance ?? (input.toolResults.length > 0 ? 0.8 : 0.6);
    const confidence = extracted?.confidence ?? 0.75;
    const shouldStoreMemoryItem = importance >= MEMORY_IMPORTANCE_THRESHOLD;
    if (shouldStoreMemoryItem) {
      await this.memoryItemStore.insert(input.context, {
        query: input.userMessage,
        summary: extracted?.summary ?? truncate(content, 240),
        content,
        scope: "global",
        importance,
        confidence,
        source: input.compaction?.summary ? "history_compaction" : "task_summary",
      });
    }

    const toolChain = buildToolChainSteps(input.toolResults);
    if (toolChain.length > 0) {
      await this.toolChainStore.insert(input.context, {
        query: input.userMessage,
        assistantResponse: input.assistantResponse,
        toolChain,
      });
    }

    return {
      sessionState,
      memoryItemsWritten: shouldStoreMemoryItem ? 1 : 0,
      toolChainsWritten: toolChain.length > 0 ? 1 : 0,
      observations: {
        memoryItemsWritten: shouldStoreMemoryItem ? 1 : 0,
        toolChainsWritten: toolChain.length > 0 ? 1 : 0,
        memoryItemsRetrieved: 0,
        toolChainsRetrieved: 0,
        compiledChars: 0,
        estimatedTokens: 0,
      },
    };
  }
}

function buildSessionState(input: MemoryWriteInput): SessionStateRecord {
  const now = new Date().toISOString();
  return {
    sessionId: input.context.sessionId,
    userId: input.context.userId,
    agentId: input.context.agentId,
    projectId: input.context.projectId,
    state: {
      recentMessages: input.sessionMessages,
      taskState: input.currentTaskState ?? deriveTaskState(input, now),
    },
    updatedAt: now,
  };
}

function buildToolChainSteps(toolResults: MemoryWriteInput["toolResults"]): ToolChainStep[] {
  return toolResults.map((result) => result.ok
    ? {
      toolName: result.toolName,
      ok: true,
      startedAt: result.startedAt,
      finishedAt: result.finishedAt,
      durationMs: result.durationMs,
      data: result.data,
    }
    : {
      toolName: result.toolName,
      ok: false,
      startedAt: result.startedAt,
      finishedAt: result.finishedAt,
      durationMs: result.durationMs,
      error: result.error,
    });
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

function buildMemoryItemContent(input: MemoryWriteInput, summary: string | undefined): string {
  const parts = [
    `User query: ${input.userMessage}`,
    input.compaction?.summary ? `Compacted history: ${input.compaction.summary}` : undefined,
    summary ? `Summary: ${summary}` : undefined,
    `Assistant response: ${input.assistantResponse}`,
    input.toolResults.length > 0
      ? `Tool chain: ${input.toolResults.map((result) => result.toolName).join(" -> ")}`
      : undefined,
  ];
  return parts.filter(Boolean).join("\n");
}

function truncate(value: string, maxLength: number): string {
  return value.length <= maxLength ? value : `${value.slice(0, maxLength)}...`;
}
