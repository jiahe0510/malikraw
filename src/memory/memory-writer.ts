import type {
  ArtifactStore,
  KnowledgeArtifactCandidate,
  MemoryWriteInput,
  MemoryWriteResult,
  SessionStateRecord,
  SessionStateStore,
  ProceduralArtifactCandidate,
  ToolChainStep,
} from "./types.js";

const MAX_SESSION_HANDOFFS = 4;
const MAX_SESSION_NOTES = 12;

export class MemoryWriter {
  constructor(
    private readonly sessionStore: SessionStateStore,
    private readonly artifactStore: ArtifactStore,
  ) {}

  async write(input: MemoryWriteInput): Promise<MemoryWriteResult> {
    const sessionState = await buildSessionSnapshot(this.sessionStore, input);
    await this.sessionStore.write(sessionState);

    const knowledgeArtifacts = buildLongTermMemoryCandidates(input);
    for (const artifact of knowledgeArtifacts) {
      await this.artifactStore.insertKnowledge(input.context, artifact);
    }

    const proceduralArtifact = buildProceduralArtifactCandidate(input);
    if (proceduralArtifact) {
      await this.artifactStore.insertProcedural(input.context, proceduralArtifact);
    }

    return {
      sessionState,
      knowledgeArtifactsWritten: knowledgeArtifacts.length,
      proceduralArtifactsWritten: proceduralArtifact ? 1 : 0,
      observations: {
        knowledgeArtifactsWritten: knowledgeArtifacts.length,
        proceduralArtifactsWritten: proceduralArtifact ? 1 : 0,
        knowledgeArtifactsRetrieved: 0,
        proceduralArtifactsRetrieved: 0,
        compiledChars: 0,
        estimatedTokens: 0,
      },
    };
  }
}

function buildProceduralArtifactCandidate(input: MemoryWriteInput): ProceduralArtifactCandidate | undefined {
  const toolChain = buildProceduralSteps(input);
  if (toolChain.length === 0) {
    return undefined;
  }

  return {
        query: input.userMessage,
        assistantResponse: input.assistantResponse,
        toolChain,
        memoryType: "procedural",
        layer: "ltm",
        status: "consolidated",
        salience: clamp01(Math.min(1, 0.45 + toolChain.length * 0.1)),
        retrievalWeight: clamp01(Math.min(1, 0.55 + toolChain.length * 0.08)),
        repressionScore: 0,
        consolidationState: "promoted",
        version: 1,
        sourceRef: {
          kind: "tool_chain",
          sessionId: input.context.sessionId,
          userId: input.context.userId,
          agentId: input.context.agentId,
          projectId: input.context.projectId,
          trigger: input.trigger,
        },
        tags: buildProceduralTags(input),
        entities: uniqueStrings(toolChain.map((step) => step.toolName)),
        triggerCues: extractTriggerCues(input.userMessage),
      };
}

async function buildSessionSnapshot(
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
    memoryType: "session_snapshot",
    layer: "stm",
    status: "active",
    salience: input.trigger === "compaction" ? 0.82 : 0.68,
    retrievalWeight: 0.78,
    repressionScore: 0,
    consolidationState: "pending",
    version: 1,
    sourceRef: {
      kind: input.trigger === "compaction" ? "compaction" : "conversation",
      sessionId: input.context.sessionId,
      userId: input.context.userId,
      agentId: input.context.agentId,
      projectId: input.context.projectId,
      trigger: input.trigger,
    },
    tags: buildSessionSnapshotTags(input),
    triggerCues: extractTriggerCues(input.userMessage),
    entities: extractEntitiesFromTools(input.toolResults),
    state: {
      handoff: nextHandoff,
      notes: nextNotes,
    },
    updatedAt: now,
  };
}

function buildLongTermMemoryCandidates(input: MemoryWriteInput): KnowledgeArtifactCandidate[] {
  const candidates: KnowledgeArtifactCandidate[] = [];
  if (input.trigger === "compaction" && input.compaction?.summary) {
    const summary = truncate(normalizeLine(input.compaction.summary), 240);
    candidates.push({
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
      memoryType: "episodic",
      layer: "ltm",
      status: "consolidated",
      salience: 0.92,
      retrievalWeight: 0.88,
      repressionScore: 0,
      consolidationState: "promoted",
      version: 1,
      sourceRef: {
        kind: "compaction",
        sessionId: input.context.sessionId,
        userId: input.context.userId,
        agentId: input.context.agentId,
        projectId: input.context.projectId,
        trigger: input.trigger,
      },
      tags: ["compaction", "handoff", "episodic"],
      entities: extractEntitiesFromTools(input.toolResults),
      triggerCues: extractTriggerCues(input.userMessage),
    });

    const symptom = buildSymptomCandidate(input);
    if (symptom) {
      candidates.push(symptom);
    }

    const repressed = buildRepressedCandidate(input);
    if (repressed) {
      candidates.push(repressed);
    }
  }

  if (input.trigger === "explicit_memory") {
    const note = extractExplicitMemoryNote(input.userMessage);
    if (!note) {
      return candidates;
    }

    candidates.push({
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
      memoryType: "semantic",
      layer: "ltm",
      status: "consolidated",
      salience: 1,
      retrievalWeight: 0.95,
      repressionScore: 0,
      consolidationState: "promoted",
      version: 1,
      sourceRef: {
        kind: "conversation",
        sessionId: input.context.sessionId,
        userId: input.context.userId,
        agentId: input.context.agentId,
        projectId: input.context.projectId,
        trigger: input.trigger,
      },
      tags: ["explicit-memory", "semantic"],
      triggerCues: extractTriggerCues(note),
    });

    const affective = buildAffectiveCandidate(input, note);
    if (affective) {
      candidates.push(affective);
    }
  }

  return dedupeCandidates(candidates);
}

function buildProceduralSteps(toolResultsOrInput: MemoryWriteInput | MemoryWriteInput["toolResults"]): ToolChainStep[] {
  const toolResults = Array.isArray(toolResultsOrInput) ? toolResultsOrInput : toolResultsOrInput.toolResults;
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

function buildAffectiveCandidate(
  input: MemoryWriteInput,
  note: string,
): KnowledgeArtifactCandidate | undefined {
  if (!hasAffectiveSignal(note)) {
    return undefined;
  }

  return {
    query: input.userMessage,
    summary: truncate(`Affective trace: ${note}`, 240),
    content: [
      `Observed emotionally salient user note: ${note}`,
      "Treat this as an affective memory signal rather than a stable fact.",
      input.assistantResponse ? `Assistant response: ${input.assistantResponse}` : undefined,
    ].filter(Boolean).join("\n"),
    scope: "global",
    importance: 0.86,
    confidence: 0.74,
    source: "user_explicit",
    memoryType: "affective",
    layer: "ltm",
    status: "consolidated",
    salience: 0.9,
    retrievalWeight: 0.62,
    repressionScore: 0.18,
    consolidationState: "promoted",
    version: 1,
    sourceRef: {
      kind: "conversation",
      sessionId: input.context.sessionId,
      userId: input.context.userId,
      agentId: input.context.agentId,
      projectId: input.context.projectId,
      trigger: input.trigger,
    },
    tags: ["affective", "explicit-memory"],
    triggerCues: extractTriggerCues(note),
  };
}

function buildSymptomCandidate(input: MemoryWriteInput): KnowledgeArtifactCandidate | undefined {
  const evidenceText = normalizeLine([
    input.userMessage,
    input.assistantResponse,
    input.compaction?.summary ?? "",
  ].join(" "));

  if (!hasSymptomSignal(evidenceText)) {
    return undefined;
  }

  return {
    query: input.userMessage,
    summary: truncate(`Pattern memory: ${input.compaction?.summary ?? input.userMessage}`, 240),
    content: [
      "Recurring pattern detected during consolidation.",
      `Evidence: ${truncate(evidenceText, 220)}`,
      "Use as a pattern-level hint, not as a user-facing fact.",
    ].join("\n"),
    scope: "global",
    importance: 0.84,
    confidence: 0.68,
    source: "history_compaction",
    memoryType: "symptom",
    layer: "ltm",
    status: "consolidated",
    salience: 0.83,
    retrievalWeight: 0.58,
    repressionScore: 0.28,
    consolidationState: "promoted",
    version: 1,
    sourceRef: {
      kind: "compaction",
      sessionId: input.context.sessionId,
      userId: input.context.userId,
      agentId: input.context.agentId,
      projectId: input.context.projectId,
      trigger: input.trigger,
    },
    tags: ["symptom", "pattern", "compaction"],
    triggerCues: extractTriggerCues(evidenceText),
    entities: extractEntitiesFromTools(input.toolResults),
  };
}

function buildRepressedCandidate(input: MemoryWriteInput): KnowledgeArtifactCandidate | undefined {
  const evidenceText = normalizeLine([
    input.userMessage,
    input.assistantResponse,
    input.compaction?.summary ?? "",
  ].join(" "));

  if (!hasRepressedSignal(evidenceText)) {
    return undefined;
  }

  return {
    query: input.userMessage,
    summary: truncate(`Guarded hypothesis: ${input.compaction?.summary ?? input.userMessage}`, 240),
    content: [
      "Tentative latent interpretation retained under guarded access.",
      `Evidence: ${truncate(evidenceText, 220)}`,
      "Do not surface directly as fact in normal mode.",
    ].join("\n"),
    scope: "global",
    importance: 0.72,
    confidence: 0.42,
    source: "history_compaction",
    memoryType: "repressed",
    layer: "ltm",
    status: "repressed",
    salience: 0.71,
    retrievalWeight: 0.19,
    repressionScore: 0.87,
    consolidationState: "promoted",
    version: 1,
    sourceRef: {
      kind: "compaction",
      sessionId: input.context.sessionId,
      userId: input.context.userId,
      agentId: input.context.agentId,
      projectId: input.context.projectId,
      trigger: input.trigger,
    },
    tags: ["repressed", "guarded", "compaction"],
    triggerCues: extractTriggerCues(evidenceText),
    entities: extractEntitiesFromTools(input.toolResults),
  };
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

function extractTriggerCues(value: string): string[] {
  return uniqueStrings(
    normalizeLine(value)
      .split(/\s+/)
      .filter((token) => token.length >= 2)
      .slice(0, 8),
  );
}

function extractEntitiesFromTools(toolResults: MemoryWriteInput["toolResults"]): string[] {
  const entities: string[] = [];
  for (const result of toolResults) {
    entities.push(result.toolName);
    const data = result.ok ? result.data : result.error;
    if (data && typeof data === "object" && !Array.isArray(data)) {
      const pathValue = (data as Record<string, unknown>).path;
      if (typeof pathValue === "string" && pathValue.trim()) {
        entities.push(pathValue.trim());
      }
    }
  }
  return uniqueStrings(entities);
}

function buildSessionSnapshotTags(input: MemoryWriteInput): string[] {
  return uniqueStrings([
    "session",
    "snapshot",
    input.trigger,
    input.toolResults.length > 0 ? "tools-used" : "",
  ]);
}

function buildProceduralTags(input: MemoryWriteInput): string[] {
  return uniqueStrings([
    "procedural",
    "tool-chain",
    input.trigger,
  ]);
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value));
}

function hasAffectiveSignal(value: string): boolean {
  return /焦虑|紧张|害怕|恐惧|羞耻|羞辱|愤怒|痛苦|崩溃|anxious|anxiety|afraid|fear|shame|humiliation|panic|overwhelmed/i.test(value);
}

function hasSymptomSignal(value: string): boolean {
  return /反复|重复|总是|每次|回避|拖延|矛盾|冲突|recurring|repeated|always|every time|avoid|avoidance|delay|contradiction|conflict/i.test(value);
}

function hasRepressedSignal(value: string): boolean {
  return /羞耻|羞辱|humiliation|shame|创伤|trauma|隐藏|latent|tentative|speculative|judgment|judgement|被评价|anticipated failure/i.test(value);
}

function dedupeCandidates(candidates: KnowledgeArtifactCandidate[]): KnowledgeArtifactCandidate[] {
  const seen = new Set<string>();
  const result: KnowledgeArtifactCandidate[] = [];
  for (const candidate of candidates) {
    const key = `${candidate.memoryType ?? "semantic"}::${candidate.summary}::${candidate.content}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    result.push(candidate);
  }
  return result;
}
