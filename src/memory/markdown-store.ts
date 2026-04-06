import path from "node:path";

import { listFilesRecursive, quarantineCorruptFile, readTextFile, withFileLock, writeTextFileAtomic } from "./file-store.js";
import type {
  KnowledgeArtifactRecord,
  MemoryArtifactType,
  MemoryContext,
  MemoryLayer,
  MemorySourceRef,
  MemoryStatus,
  ProceduralArtifactRecord,
  SessionStateRecord,
} from "./types.js";
import { getMemoryStoreDirectory } from "./session-store.js";

type FrontmatterRecord = Record<string, unknown>;

const FRONTMATTER_OPEN = "---\n";
const FRONTMATTER_CLOSE = "\n---\n";

export function getAgentMemoryDirectory(agentId: string): string {
  return path.join(getMemoryStoreDirectory(), "agents", sanitizePathSegment(agentId));
}

export function getAgentStmDirectory(agentId: string): string {
  return path.join(getAgentMemoryDirectory(agentId), "stm");
}

export function getAgentLtmDirectory(agentId: string): string {
  return path.join(getAgentMemoryDirectory(agentId), "ltm");
}

export function getStmInboxDirectory(agentId: string): string {
  return path.join(getAgentStmDirectory(agentId), "inbox");
}

export function getStmActiveDirectory(agentId: string): string {
  return path.join(getAgentStmDirectory(agentId), "active");
}

export function getStmSnapshotsDirectory(agentId: string): string {
  return path.join(getAgentStmDirectory(agentId), "snapshots");
}

export function getLtmMemoryTypeDirectory(agentId: string, memoryType: Exclude<MemoryArtifactType, "session_snapshot" | "session_note" | "conflict">): string {
  return path.join(getAgentLtmDirectory(agentId), memoryType);
}

export function getSessionMemoryDirectory(context: MemoryContext): string {
  return path.join(
    getStmSnapshotsDirectory(context.agentId),
    "sessions",
    sanitizePathSegment(context.sessionId),
  );
}

export function getSessionStateFilePath(context: MemoryContext): string {
  return path.join(getSessionMemoryDirectory(context), "session.md");
}

export function getKnowledgeArtifactFilePath(record: KnowledgeArtifactRecord): string {
  const memoryType = inferKnowledgeMemoryType(record);
  return path.join(
    getLtmMemoryTypeDirectory(record.agentId, memoryType),
    `${record.createdAt.replaceAll(":", "-")}-${record.id}.md`,
  );
}

export function getProceduralArtifactFilePath(record: ProceduralArtifactRecord): string {
  return path.join(
    getLtmMemoryTypeDirectory(record.agentId, "procedural"),
    `${record.createdAt.replaceAll(":", "-")}-${record.id}.md`,
  );
}

export async function readSessionStateMarkdown(filePath: string): Promise<SessionStateRecord | undefined> {
  const raw = await readTextFile(filePath);
  if (raw === undefined) {
    return undefined;
  }

  try {
    return normalizeSessionStateRecord(parseFrontmatter<unknown>(raw));
  } catch {
    await quarantineCorruptFile(filePath);
    return undefined;
  }
}

export async function writeSessionStateMarkdown(record: SessionStateRecord): Promise<void> {
  const filePath = getSessionStateFilePath(record);
  await withFileLock(filePath, async () => {
    await writeTextFileAtomic(filePath, renderSessionStateMarkdown(record));
  });
}

export async function listKnowledgeArtifactMarkdownRecords(agentId: string): Promise<KnowledgeArtifactRecord[]> {
  const [semantic, episodic, affective, repressed, symptom, relational] = await Promise.all([
    listMarkdownRecords(getLtmMemoryTypeDirectory(agentId, "semantic"), parseKnowledgeArtifactMarkdown),
    listMarkdownRecords(getLtmMemoryTypeDirectory(agentId, "episodic"), parseKnowledgeArtifactMarkdown),
    listMarkdownRecords(getLtmMemoryTypeDirectory(agentId, "affective"), parseKnowledgeArtifactMarkdown),
    listMarkdownRecords(getLtmMemoryTypeDirectory(agentId, "repressed"), parseKnowledgeArtifactMarkdown),
    listMarkdownRecords(getLtmMemoryTypeDirectory(agentId, "symptom"), parseKnowledgeArtifactMarkdown),
    listMarkdownRecords(getLtmMemoryTypeDirectory(agentId, "relational"), parseKnowledgeArtifactMarkdown),
  ]);
  return [...semantic, ...episodic, ...affective, ...repressed, ...symptom, ...relational];
}

export async function writeKnowledgeArtifactMarkdown(record: KnowledgeArtifactRecord): Promise<void> {
  const filePath = getKnowledgeArtifactFilePath(record);
  await withFileLock(filePath, async () => {
    await writeTextFileAtomic(filePath, renderKnowledgeArtifactMarkdown(record));
  });
}

export async function listProceduralArtifactMarkdownRecords(agentId: string): Promise<ProceduralArtifactRecord[]> {
  return listMarkdownRecords(getLtmMemoryTypeDirectory(agentId, "procedural"), parseProceduralArtifactMarkdown);
}

export async function writeProceduralArtifactMarkdown(record: ProceduralArtifactRecord): Promise<void> {
  const filePath = getProceduralArtifactFilePath(record);
  await withFileLock(filePath, async () => {
    await writeTextFileAtomic(filePath, renderProceduralArtifactMarkdown(record));
  });
}

export function renderSessionStateMarkdown(record: SessionStateRecord): string {
  const frontmatter = decorateSessionStateRecord(record);
  return [
    renderFrontmatter(frontmatter),
    "# STM Session Snapshot",
    "",
    `- Session: \`${record.sessionId}\``,
    `- User: \`${record.userId}\``,
    `- Agent: \`${record.agentId}\``,
    `- Updated: ${record.updatedAt}`,
    "",
    "## Session Handoff",
    "",
    ...toBulletLines(record.state.handoff),
    "",
    "## Remembered Notes",
    "",
    ...toBulletLines(record.state.notes),
    "",
  ].join("\n");
}

export function renderKnowledgeArtifactMarkdown(record: KnowledgeArtifactRecord): string {
  const frontmatter = decorateKnowledgeArtifactRecord(record);
  return [
    renderFrontmatter(frontmatter),
    `# LTM ${singleLine(record.memoryType ?? "semantic")} Artifact`,
    "",
    `- Query: ${singleLine(record.query)}`,
    `- Scope: ${record.scope}`,
    `- Importance: ${record.importance}`,
    `- Confidence: ${record.confidence}`,
    `- Source: ${record.source}`,
    "",
    "## Summary",
    "",
    record.summary,
    "",
    "## Content",
    "",
    record.content,
    "",
  ].join("\n");
}

export function renderProceduralArtifactMarkdown(record: ProceduralArtifactRecord): string {
  const frontmatter = decorateProceduralArtifactRecord(record);
  return [
    renderFrontmatter(frontmatter),
    "# LTM Procedural Memory",
    "",
    `- Query: ${singleLine(record.query)}`,
    `- Session: \`${record.sessionId}\``,
    `- Steps: ${record.toolChain.length}`,
    "",
    "## Assistant Response",
    "",
    record.assistantResponse || "-",
    "",
    "## Tool Chain",
    "",
    ...(record.toolChain.length > 0
      ? record.toolChain.map((step, index) =>
        `${index + 1}. \`${step.toolName}\` (${step.ok ? "ok" : "fail"}, ${step.durationMs}ms)`)
      : ["- None"]),
    "",
  ].join("\n");
}

function parseKnowledgeArtifactMarkdown(raw: string): KnowledgeArtifactRecord {
  return parseFrontmatter<KnowledgeArtifactRecord>(raw);
}

function parseProceduralArtifactMarkdown(raw: string): ProceduralArtifactRecord {
  return parseFrontmatter<ProceduralArtifactRecord>(raw);
}

function renderFrontmatter(record: FrontmatterRecord): string {
  return `${FRONTMATTER_OPEN}${JSON.stringify(record, null, 2)}${FRONTMATTER_CLOSE}`;
}

function parseFrontmatter<T>(raw: string): T {
  if (!raw.startsWith(FRONTMATTER_OPEN)) {
    throw new Error("Missing markdown frontmatter.");
  }

  const end = raw.indexOf(FRONTMATTER_CLOSE, FRONTMATTER_OPEN.length);
  if (end === -1) {
    throw new Error("Invalid markdown frontmatter.");
  }

  const json = raw.slice(FRONTMATTER_OPEN.length, end);
  return JSON.parse(json) as T;
}

function normalizeSessionStateRecord(value: unknown): SessionStateRecord {
  const record = value as Record<string, unknown>;
  const stateRecord = (record.state ?? {}) as Record<string, unknown>;

  const handoff = Array.isArray(stateRecord.handoff)
    ? stateRecord.handoff.filter((entry): entry is string => typeof entry === "string")
    : normalizeLegacyHandoff(stateRecord);
  const notes = Array.isArray(stateRecord.notes)
    ? stateRecord.notes.filter((entry): entry is string => typeof entry === "string")
    : [];

  return {
    sessionId: typeof record.sessionId === "string" ? record.sessionId : "default",
    userId: typeof record.userId === "string" ? record.userId : "anonymous",
    agentId: typeof record.agentId === "string" ? record.agentId : "default",
    projectId: typeof record.projectId === "string" ? record.projectId : undefined,
    updatedAt: typeof record.updatedAt === "string" ? record.updatedAt : new Date().toISOString(),
    memoryType: normalizeMemoryType(record.memoryType, "session_snapshot"),
    layer: normalizeMemoryLayer(record.layer, "stm"),
    status: normalizeMemoryStatus(record.status, "active"),
    salience: normalizeNumber(record.salience, 0.6),
    retrievalWeight: normalizeNumber(record.retrievalWeight, 0.7),
    repressionScore: normalizeNumber(record.repressionScore, 0),
    consolidationState: normalizeConsolidationState(record.consolidationState, "pending"),
    version: normalizeNumber(record.version, 1),
    sourceRef: normalizeSourceRef(record.sourceRef, record),
    tags: normalizeStringArray(record.tags),
    entities: normalizeStringArray(record.entities),
    triggerCues: normalizeStringArray(record.triggerCues),
    linkedMemories: normalizeStringArray(record.linkedMemories),
    screenFor: normalizeStringArray(record.screenFor),
    state: {
      handoff,
      notes,
    },
  };
}

function decorateSessionStateRecord(record: SessionStateRecord): FrontmatterRecord {
  return {
    ...record,
    memoryType: record.memoryType ?? "session_snapshot",
    layer: record.layer ?? "stm",
    status: record.status ?? "active",
    salience: record.salience ?? 0.6,
    retrievalWeight: record.retrievalWeight ?? 0.75,
    repressionScore: record.repressionScore ?? 0,
    consolidationState: record.consolidationState ?? "pending",
    version: record.version ?? 1,
    sourceRef: record.sourceRef ?? {
      kind: "conversation",
      sessionId: record.sessionId,
      userId: record.userId,
      agentId: record.agentId,
      projectId: record.projectId,
    },
    tags: record.tags ?? ["session", "snapshot"],
    entities: record.entities ?? [],
    triggerCues: record.triggerCues ?? [],
    linkedMemories: record.linkedMemories ?? [],
    screenFor: record.screenFor ?? [],
  };
}

function decorateKnowledgeArtifactRecord(record: KnowledgeArtifactRecord): FrontmatterRecord {
  return {
    ...record,
    family: "knowledge",
    memoryType: record.memoryType ?? inferKnowledgeMemoryType(record),
    layer: record.layer ?? "ltm",
    status: record.status ?? "consolidated",
    salience: record.salience ?? clamp01(record.importance),
    retrievalWeight: record.retrievalWeight ?? clamp01(record.importance),
    repressionScore: record.repressionScore ?? 0,
    consolidationState: record.consolidationState ?? "promoted",
    version: record.version ?? 1,
    sourceRef: record.sourceRef ?? {
      kind: record.source === "history_compaction" ? "compaction" : "conversation",
      sessionId: record.scope === "session" ? undefined : undefined,
      userId: record.userId,
      agentId: record.agentId,
    },
    tags: record.tags ?? [record.source, record.scope, record.memoryType ?? "semantic"],
    entities: record.entities ?? [],
    triggerCues: record.triggerCues ?? extractTriggerCues(record.query),
    linkedMemories: record.linkedMemories ?? [],
    screenFor: record.screenFor ?? [],
  };
}

function decorateProceduralArtifactRecord(record: ProceduralArtifactRecord): FrontmatterRecord {
  return {
    ...record,
    family: "procedural",
    memoryType: record.memoryType ?? "procedural",
    layer: record.layer ?? "ltm",
    status: record.status ?? "consolidated",
    salience: record.salience ?? clamp01(Math.min(1, 0.4 + record.toolChain.length * 0.1)),
    retrievalWeight: record.retrievalWeight ?? clamp01(Math.min(1, 0.5 + record.toolChain.length * 0.08)),
    repressionScore: record.repressionScore ?? 0,
    consolidationState: record.consolidationState ?? "promoted",
    version: record.version ?? 1,
    sourceRef: record.sourceRef ?? {
      kind: "tool_chain",
      sessionId: record.sessionId,
      userId: record.userId,
      agentId: record.agentId,
      projectId: record.projectId,
    },
    tags: record.tags ?? ["tool-chain", "procedural"],
    entities: record.entities ?? record.toolChain.map((step) => step.toolName),
    triggerCues: record.triggerCues ?? extractTriggerCues(record.query),
    linkedMemories: record.linkedMemories ?? [],
    screenFor: record.screenFor ?? [],
  };
}

function normalizeLegacyHandoff(stateRecord: Record<string, unknown>): string[] {
  const taskState = (stateRecord.taskState ?? {}) as Record<string, unknown>;
  const recentMessages = Array.isArray(stateRecord.recentMessages)
    ? stateRecord.recentMessages
      .map((message) => {
        const item = message as Record<string, unknown>;
        const role = typeof item.role === "string" ? item.role : "unknown";
        const content = typeof item.content === "string" ? singleLine(item.content) : "";
        return content ? `${role}: ${content}` : "";
      })
      .filter(Boolean)
    : [];

  const lines = [
    typeof taskState.goal === "string" && taskState.goal.trim() ? `Goal: ${taskState.goal.trim()}` : undefined,
    Array.isArray(taskState.currentPlan) && taskState.currentPlan.length > 0
      ? `Current plan: ${taskState.currentPlan.filter((entry): entry is string => typeof entry === "string").join("; ")}`
      : undefined,
    Array.isArray(taskState.completedSteps) && taskState.completedSteps.length > 0
      ? `Completed: ${taskState.completedSteps.filter((entry): entry is string => typeof entry === "string").join("; ")}`
      : undefined,
    Array.isArray(taskState.openQuestions) && taskState.openQuestions.length > 0
      ? `Open questions: ${taskState.openQuestions.filter((entry): entry is string => typeof entry === "string").join("; ")}`
      : undefined,
    recentMessages.length > 0 ? `Recent transcript: ${recentMessages.slice(-4).join(" | ")}` : undefined,
  ].filter((line): line is string => Boolean(line));

  return lines.length > 0 ? lines : [];
}

async function listMarkdownRecords<T>(directoryPath: string, parser: (raw: string) => T): Promise<T[]> {
  const files = await listFilesRecursive(directoryPath, ".md");
  const records: Array<T | undefined> = await Promise.all(files.map(async (filePath) => {
    const raw = await readTextFile(filePath);
    if (raw === undefined) {
      return undefined;
    }

    try {
      return parser(raw);
    } catch {
      await quarantineCorruptFile(filePath);
      return undefined;
    }
  }));

  return records.filter((record): record is T => record !== undefined);
}

function sanitizePathSegment(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]/g, "_");
}

function normalizeString(value: unknown, fallback: string): string {
  return typeof value === "string" && value.trim() ? value : fallback;
}

function normalizeNumber(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function normalizeStringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === "string" && entry.trim().length > 0)
    : [];
}

function normalizeMemoryType(value: unknown, fallback: MemoryArtifactType): MemoryArtifactType {
  const normalized = typeof value === "string" ? value : "";
  switch (normalized) {
    case "session_snapshot":
    case "session_note":
    case "semantic":
    case "episodic":
    case "procedural":
    case "relational":
    case "affective":
    case "repressed":
    case "symptom":
    case "conflict":
      return normalized;
    default:
      return fallback;
  }
}

function normalizeMemoryLayer(value: unknown, fallback: MemoryLayer): MemoryLayer {
  return value === "stm" || value === "ltm" ? value : fallback;
}

function normalizeMemoryStatus(value: unknown, fallback: MemoryStatus): MemoryStatus {
  switch (value) {
    case "active":
    case "cooling":
    case "consolidated":
    case "suppressed":
    case "repressed":
    case "archived":
    case "invalidated":
      return value;
    default:
      return fallback;
  }
}

function normalizeConsolidationState(
  value: unknown,
  fallback: "pending" | "merged" | "promoted" | "archived" | "discarded",
): "pending" | "merged" | "promoted" | "archived" | "discarded" {
  switch (value) {
    case "pending":
    case "merged":
    case "promoted":
    case "archived":
    case "discarded":
      return value;
    default:
      return fallback;
  }
}

function normalizeSourceRef(value: unknown, record: Record<string, unknown>): MemorySourceRef | undefined {
  if (value && typeof value === "object") {
    const sourceRef = value as Record<string, unknown>;
    const kind = typeof sourceRef.kind === "string"
      && ["conversation", "compaction", "tool_chain", "reflection"].includes(sourceRef.kind)
      ? sourceRef.kind as MemorySourceRef["kind"]
      : "conversation";
    return {
      kind,
      sessionId: typeof sourceRef.sessionId === "string" ? sourceRef.sessionId : undefined,
      userId: typeof sourceRef.userId === "string" ? sourceRef.userId : undefined,
      agentId: typeof sourceRef.agentId === "string" ? sourceRef.agentId : undefined,
      projectId: typeof sourceRef.projectId === "string" ? sourceRef.projectId : undefined,
      turnIds: Array.isArray(sourceRef.turnIds)
        ? sourceRef.turnIds.filter((entry): entry is string | number => typeof entry === "string" || typeof entry === "number")
        : undefined,
      trigger: sourceRef.trigger === "compaction" || sourceRef.trigger === "explicit_memory"
        ? sourceRef.trigger
        : undefined,
    };
  }

  return {
    kind: "conversation",
    sessionId: typeof record.sessionId === "string" ? record.sessionId : undefined,
    userId: typeof record.userId === "string" ? record.userId : undefined,
    agentId: typeof record.agentId === "string" ? record.agentId : undefined,
    projectId: typeof record.projectId === "string" ? record.projectId : undefined,
  };
}

function inferKnowledgeMemoryType(record: KnowledgeArtifactRecord): Exclude<MemoryArtifactType, "session_snapshot" | "session_note" | "conflict" | "procedural"> {
  switch (record.memoryType) {
    case "semantic":
    case "episodic":
    case "relational":
    case "affective":
    case "repressed":
    case "symptom":
      return record.memoryType;
    default:
      return record.source === "history_compaction" ? "episodic" : "semantic";
  }
}

function extractTriggerCues(query: string): string[] {
  return singleLine(query)
    .split(/\s+/)
    .map((token) => token.trim())
    .filter((token) => token.length >= 3)
    .slice(0, 8);
}

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value));
}

function singleLine(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function toBulletLines(values: string[]): string[] {
  return values.length > 0 ? values.map((value) => `- ${value}`) : ["- None"];
}
