import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import { getMalikrawHomeDirectory } from "../core/config/config-store.js";
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
  constructor(
    private readonly filePath = path.join(getMemoryStoreDirectory(), "session-state.json"),
  ) {}

  async read(context: MemoryContext): Promise<SessionStateRecord | undefined> {
    const records = await this.readAll();
    return records[buildSessionStateKey(context)];
  }

  async write(record: SessionStateRecord): Promise<void> {
    const records = await this.readAll();
    records[buildSessionStateKey(record)] = record;
    await this.writeAll(records);
  }

  private async readAll(): Promise<Record<string, SessionStateRecord>> {
    try {
      const raw = await readFile(this.filePath, "utf8");
      return JSON.parse(raw) as Record<string, SessionStateRecord>;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "ENOENT") {
        return {};
      }
      throw error;
    }
  }

  private async writeAll(records: Record<string, SessionStateRecord>): Promise<void> {
    await mkdir(path.dirname(this.filePath), { recursive: true });
    await writeFile(this.filePath, `${JSON.stringify(records, null, 2)}\n`, "utf8");
  }
}

export function getMemoryStoreDirectory(): string {
  return path.join(getMalikrawHomeDirectory(), ".runtime", "memory");
}

function buildSessionStateKey(context: Pick<MemoryContext, "sessionId" | "agentId" | "userId">): string {
  return `${context.userId}:${context.agentId}:${context.sessionId}`;
}
