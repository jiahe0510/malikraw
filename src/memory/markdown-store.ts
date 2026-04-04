import path from "node:path";

import { listFilesRecursive, quarantineCorruptFile, readTextFile, withFileLock, writeTextFileAtomic } from "./file-store.js";
import type { MemoryContext, QueryMemoryItemRecord, SessionStateRecord, ToolChainMemoryRecord } from "./types.js";
import { getMemoryStoreDirectory } from "./session-store.js";

type FrontmatterRecord = Record<string, unknown>;

const FRONTMATTER_OPEN = "---\n";
const FRONTMATTER_CLOSE = "\n---\n";

export function getAgentMemoryDirectory(agentId: string): string {
  return path.join(getMemoryStoreDirectory(), "agents", sanitizePathSegment(agentId));
}

export function getGlobalMemoryItemsDirectory(agentId: string): string {
  return path.join(getAgentMemoryDirectory(agentId), "global", "memory-items");
}

export function getGlobalToolChainsDirectory(agentId: string): string {
  return path.join(getAgentMemoryDirectory(agentId), "global", "tool-chains");
}

export function getSessionMemoryDirectory(context: MemoryContext): string {
  return path.join(
    getAgentMemoryDirectory(context.agentId),
    "sessions",
    sanitizePathSegment(context.sessionId),
  );
}

export function getSessionStateFilePath(context: MemoryContext): string {
  return path.join(getSessionMemoryDirectory(context), "session.md");
}

export function getMemoryItemFilePath(record: QueryMemoryItemRecord): string {
  return path.join(
    getGlobalMemoryItemsDirectory(record.agentId),
    `${record.createdAt.replaceAll(":", "-")}-${record.id}.md`,
  );
}

export function getToolChainFilePath(record: ToolChainMemoryRecord): string {
  return path.join(
    getGlobalToolChainsDirectory(record.agentId),
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

export async function listMemoryItemMarkdownRecords(agentId: string): Promise<QueryMemoryItemRecord[]> {
  return listMarkdownRecords(getGlobalMemoryItemsDirectory(agentId), parseMemoryItemMarkdown);
}

export async function writeMemoryItemMarkdown(record: QueryMemoryItemRecord): Promise<void> {
  const filePath = getMemoryItemFilePath(record);
  await withFileLock(filePath, async () => {
    await writeTextFileAtomic(filePath, renderMemoryItemMarkdown(record));
  });
}

export async function listToolChainMarkdownRecords(agentId: string): Promise<ToolChainMemoryRecord[]> {
  return listMarkdownRecords(getGlobalToolChainsDirectory(agentId), parseToolChainMarkdown);
}

export async function writeToolChainMarkdown(record: ToolChainMemoryRecord): Promise<void> {
  const filePath = getToolChainFilePath(record);
  await withFileLock(filePath, async () => {
    await writeTextFileAtomic(filePath, renderToolChainMarkdown(record));
  });
}

export function renderSessionStateMarkdown(record: SessionStateRecord): string {
  return [
    renderFrontmatter(record),
    "# Session Memory",
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

export function renderMemoryItemMarkdown(record: QueryMemoryItemRecord): string {
  return [
    renderFrontmatter(record),
    "# Global Memory Item",
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

export function renderToolChainMarkdown(record: ToolChainMemoryRecord): string {
  return [
    renderFrontmatter(record),
    "# Global Tool Chain",
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

function parseMemoryItemMarkdown(raw: string): QueryMemoryItemRecord {
  return parseFrontmatter<QueryMemoryItemRecord>(raw);
}

function parseToolChainMarkdown(raw: string): ToolChainMemoryRecord {
  return parseFrontmatter<ToolChainMemoryRecord>(raw);
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
    state: {
      handoff,
      notes,
    },
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

function singleLine(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function toBulletLines(values: string[]): string[] {
  return values.length > 0 ? values.map((value) => `- ${value}`) : ["- None"];
}
