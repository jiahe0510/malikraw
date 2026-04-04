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
    return parseFrontmatter<SessionStateRecord>(raw);
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
  const recentMessages = record.state.recentMessages.map((message) =>
    `- **${message.role}**: ${singleLine(message.content)}`
  );
  const taskState = record.state.taskState;

  return [
    renderFrontmatter(record),
    "# Session Memory",
    "",
    `- Session: \`${record.sessionId}\``,
    `- User: \`${record.userId}\``,
    `- Agent: \`${record.agentId}\``,
    `- Updated: ${record.updatedAt}`,
    "",
    "## Task State",
    "",
    `- Goal: ${taskState.goal ?? "-"}`,
    `- Status: ${taskState.status}`,
    `- Updated: ${taskState.updatedAt}`,
    "",
    "### Current Plan",
    ...toBulletLines(taskState.currentPlan),
    "",
    "### Completed Steps",
    ...toBulletLines(taskState.completedSteps),
    "",
    "### Open Questions",
    ...toBulletLines(taskState.openQuestions),
    "",
    "## Recent Messages",
    ...(recentMessages.length > 0 ? recentMessages : ["- None"]),
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
