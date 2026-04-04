import path from "node:path";

import { getMalikrawHomeDirectory } from "../core/config/config-store.js";
import { createTextMessage, getMessageText } from "../core/agent/message-content.js";
import type { AgentMessage } from "../core/agent/types.js";
import { readJsonFile, withFileLock, writeJsonFileAtomic } from "../memory/file-store.js";
import type { ChannelSession } from "./channel.js";

const SUMMARY_PREFIX = "[session_summary]";
const COMPACTED_HISTORY_PREFIX = "[compacted_history]";
const DEFAULT_MAX_RECENT_MESSAGES = 8;
const DEFAULT_MAX_SUMMARY_CHARS = 2400;
const DEFAULT_MAX_HISTORY_CHARS = 4000;

export interface SessionStore {
  read(session: ChannelSession): Promise<AgentMessage[]> | AgentMessage[];
  write(session: ChannelSession, messages: AgentMessage[]): Promise<void> | void;
}

export class InMemorySessionStore implements SessionStore {
  constructor(
    private readonly options: {
      maxRecentMessages?: number;
      maxSummaryChars?: number;
      maxHistoryChars?: number;
    } = {},
  ) {}

  private readonly sessions = new Map<string, AgentMessage[]>();

  read(session: ChannelSession): AgentMessage[] {
    return [...(this.sessions.get(toSessionKey(session)) ?? [])];
  }

  write(session: ChannelSession, messages: AgentMessage[]): void {
    this.sessions.set(toSessionKey(session), compactSessionMessages(messages, this.options));
  }
}

export class FileBackedSessionStore implements SessionStore {
  constructor(
    private readonly options: {
      directory?: string;
      maxRecentMessages?: number;
      maxSummaryChars?: number;
      maxHistoryChars?: number;
    } = {},
  ) {}

  async read(session: ChannelSession): Promise<AgentMessage[]> {
    const parsed = await readJsonFile<{ messages?: AgentMessage[] }>(this.getSessionFilePath(session), {});
    return Array.isArray(parsed.messages) ? parsed.messages : [];
  }

  async write(session: ChannelSession, messages: AgentMessage[]): Promise<void> {
    const compacted = compactSessionMessages(messages, this.options);
    const filePath = this.getSessionFilePath(session);
    await withFileLock(filePath, async () => {
      await writeJsonFileAtomic(filePath, { messages: compacted });
    });
  }

  private getSessionFilePath(session: ChannelSession): string {
    const baseDirectory = this.options.directory ?? getDefaultSessionStoreDirectory();
    return path.join(baseDirectory, `${encodeSessionKey(toSessionKey(session))}.json`);
  }
}

function toSessionKey(session: ChannelSession): string {
  return `${session.agentId ?? "default"}:${session.channelId}:${session.sessionId}`;
}

export function getDefaultSessionStoreDirectory(): string {
  return path.join(getMalikrawHomeDirectory(), ".runtime", "sessions");
}

export function compactSessionMessages(
  messages: AgentMessage[],
  options: {
    maxRecentMessages?: number;
    maxSummaryChars?: number;
    maxHistoryChars?: number;
  } = {},
): AgentMessage[] {
  const maxRecentMessages = options.maxRecentMessages ?? DEFAULT_MAX_RECENT_MESSAGES;
  const maxSummaryChars = options.maxSummaryChars ?? DEFAULT_MAX_SUMMARY_CHARS;
  const maxHistoryChars = options.maxHistoryChars ?? DEFAULT_MAX_HISTORY_CHARS;
  const estimatedChars = estimateHistoryChars(messages);
  if (messages.length <= maxRecentMessages && estimatedChars <= maxHistoryChars) {
    return [...messages];
  }

  const splitIndex = findRecentSplitIndex(messages, maxRecentMessages);
  const shouldCompactEntireHistory = splitIndex === 0 && estimatedChars > maxHistoryChars;
  const recentMessages = shouldCompactEntireHistory ? [] : messages.slice(splitIndex);
  const olderMessages = shouldCompactEntireHistory ? messages : messages.slice(0, splitIndex);
  const summaryMessage = buildSummaryMessage(olderMessages, maxSummaryChars);
  if (!summaryMessage) {
    return [...recentMessages];
  }

  return [summaryMessage, ...recentMessages];
}

function buildSummaryMessage(
  messages: AgentMessage[],
  maxSummaryChars: number,
): AgentMessage | undefined {
  const carriedSummaries: string[] = [];
  const lines: string[] = [];

  for (const message of messages) {
    const content = getMessageText(message);
    if (message.role === "assistant" && content.startsWith(`${SUMMARY_PREFIX}\n`)) {
      carriedSummaries.push(content.slice(`${SUMMARY_PREFIX}\n`.length).trim());
      continue;
    }

    if (message.role === "user" || message.role === "assistant") {
      lines.push(renderSummaryLine(message));
      continue;
    }

    if (message.role === "tool") {
      lines.push(renderToolSummaryLine(message));
    }
  }

  const body = [...carriedSummaries, ...lines]
    .filter(Boolean)
    .join("\n");
  const trimmedBody = truncate(body, maxSummaryChars).trim();
  if (!trimmedBody) {
    return undefined;
  }

  return createTextMessage("user", `${COMPACTED_HISTORY_PREFIX}\n${trimmedBody}`);
}

function renderSummaryLine(message: AgentMessage): string {
  return `${message.role}: ${truncate(getMessageText(message), 240)}`;
}

function renderToolSummaryLine(message: AgentMessage): string {
  return `tool ${message.toolName ?? "unknown"}: ${truncate(summarizeToolContent(getMessageText(message)), 120)}`;
}

function truncate(value: string, maxLength: number): string {
  return value.length <= maxLength ? value : `${value.slice(0, maxLength)}...`;
}

function findRecentSplitIndex(messages: AgentMessage[], maxRecentMessages: number): number {
  const fallbackIndex = Math.max(0, messages.length - maxRecentMessages);
  for (let index = fallbackIndex; index < messages.length; index += 1) {
    if (messages[index]?.role === "user") {
      return index;
    }
  }

  return fallbackIndex;
}

function estimateHistoryChars(messages: AgentMessage[]): number {
  return messages.reduce((total, message) => total + getMessageText(message).length, 0);
}

function summarizeToolContent(content: string): string {
  try {
    const parsed = JSON.parse(content) as Record<string, unknown>;
    if (typeof parsed.ok === "boolean") {
      return parsed.ok ? "ok" : "error";
    }
    if (parsed && typeof parsed === "object") {
      return "recorded result";
    }
  } catch {
    // fall back to plain text truncation
  }

  return content;
}

function encodeSessionKey(sessionKey: string): string {
  return Buffer.from(sessionKey, "utf8").toString("base64url");
}
