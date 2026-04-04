import path from "node:path";

import { getMalikrawHomeDirectory } from "../core/config/config-store.js";
import { getSessionStateFilePath, readSessionStateMarkdown, writeSessionStateMarkdown } from "./markdown-store.js";
import type { MemoryContext, SessionStateRecord, SessionStateStore } from "./types.js";

export class InMemorySessionStateStore implements SessionStateStore {
  private readonly records = new Map<string, SessionStateRecord>();

  async read(context: MemoryContext): Promise<SessionStateRecord | undefined> {
    return this.records.get(buildSessionStateKey(context));
  }

  async write(record: SessionStateRecord): Promise<void> {
    this.records.set(buildSessionStateKey(record), record);
  }
}

export class FileBackedSessionStateStore implements SessionStateStore {
  async read(context: MemoryContext): Promise<SessionStateRecord | undefined> {
    return readSessionStateMarkdown(getSessionStateFilePath(context));
  }

  async write(record: SessionStateRecord): Promise<void> {
    await writeSessionStateMarkdown(record);
  }
}

export function getMemoryStoreDirectory(): string {
  return path.join(getMalikrawHomeDirectory(), "memory");
}

function buildSessionStateKey(context: Pick<MemoryContext, "sessionId" | "agentId">): string {
  return `${context.agentId}:${context.sessionId}`;
}
