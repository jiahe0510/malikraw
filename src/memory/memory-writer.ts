import type {
  MemoryItemStore,
  MemoryWriteInput,
  MemoryWriteResult,
  SessionStateRecord,
  SessionStateStore,
  ToolChainMemoryStore,
  ToolChainStep,
} from "./types.js";

const MAX_SESSION_HANDOFFS = 4;
const MAX_SESSION_NOTES = 12;

export class MemoryWriter {
  constructor(
    private readonly sessionStore: SessionStateStore,
    private readonly memoryItemStore: MemoryItemStore,
    private readonly toolChainStore: ToolChainMemoryStore,
  ) {}

  async write(input: MemoryWriteInput): Promise<MemoryWriteResult> {
    const sessionState = await buildSessionState(this.sessionStore, input);
    await this.sessionStore.write(sessionState);

    const memoryItem = buildMemoryItemCandidate(input);
    if (memoryItem) {
      await this.memoryItemStore.insert(input.context, memoryItem);
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
      memoryItemsWritten: memoryItem ? 1 : 0,
      toolChainsWritten: toolChain.length > 0 ? 1 : 0,
      observations: {
        memoryItemsWritten: memoryItem ? 1 : 0,
        toolChainsWritten: toolChain.length > 0 ? 1 : 0,
        memoryItemsRetrieved: 0,
        toolChainsRetrieved: 0,
        compiledChars: 0,
        estimatedTokens: 0,
      },
    };
  }
}

async function buildSessionState(
  sessionStore: SessionStateStore,
  input: MemoryWriteInput,
): Promise<SessionStateRecord> {
  const now = new Date().toISOString();
  const previous = await sessionStore.read(input.context);
  const existingHandoff = previous?.state.handoff ?? [];
  const existingNotes = previous?.state.notes ?? [];

  const nextHandoff = input.trigger === "compaction" && input.compaction?.summary
    ? appendUnique(existingHandoff, normalizeLine(input.compaction.summary), MAX_SESSION_HANDOFFS)
    : existingHandoff;
  const explicitNote = input.trigger === "explicit_memory"
    ? extractExplicitMemoryNote(input.userMessage)
    : undefined;
  const nextNotes = explicitNote
    ? appendUnique(existingNotes, explicitNote, MAX_SESSION_NOTES)
    : existingNotes;

  return {
    sessionId: input.context.sessionId,
    userId: input.context.userId,
    agentId: input.context.agentId,
    projectId: input.context.projectId,
    state: {
      handoff: nextHandoff,
      notes: nextNotes,
    },
    updatedAt: now,
  };
}

function buildMemoryItemCandidate(input: MemoryWriteInput) {
  if (input.trigger === "compaction" && input.compaction?.summary) {
    const summary = truncate(normalizeLine(input.compaction.summary), 240);
    return {
      query: input.userMessage,
      summary,
      content: [
        `Compacted user request: ${input.userMessage}`,
        `Session handoff: ${input.compaction.summary}`,
        input.assistantResponse ? `Latest assistant response: ${input.assistantResponse}` : undefined,
        input.toolResults.length > 0
          ? `Tool chain: ${input.toolResults.map((result) => result.toolName).join(" -> ")}`
          : undefined,
      ].filter(Boolean).join("\n"),
      scope: "global" as const,
      importance: 0.9,
      confidence: 0.9,
      source: "history_compaction" as const,
    };
  }

  if (input.trigger === "explicit_memory") {
    const note = extractExplicitMemoryNote(input.userMessage);
    if (!note) {
      return undefined;
    }

    return {
      query: input.userMessage,
      summary: truncate(note, 240),
      content: [
        `User explicitly asked to remember: ${note}`,
        input.assistantResponse ? `Assistant response: ${input.assistantResponse}` : undefined,
      ].filter(Boolean).join("\n"),
      scope: "global" as const,
      importance: 1,
      confidence: 1,
      source: "user_explicit" as const,
    };
  }

  return undefined;
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

function extractExplicitMemoryNote(userMessage: string): string | undefined {
  const normalized = normalizeLine(userMessage);
  if (!normalized) {
    return undefined;
  }

  return normalized;
}

function appendUnique(existing: string[], value: string, limit: number): string[] {
  const normalized = value.trim();
  if (!normalized) {
    return existing.slice(-limit);
  }

  const filtered = existing.filter((entry) => entry.trim() !== normalized);
  return [...filtered, normalized].slice(-limit);
}

function normalizeLine(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function truncate(value: string, maxLength: number): string {
  return value.length <= maxLength ? value : `${value.slice(0, maxLength - 3)}...`;
}
