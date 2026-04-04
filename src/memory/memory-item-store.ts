import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import type {
  MemoryContext,
  MemoryItemStore,
  QueryMemoryItemCandidate,
  QueryMemoryItemRecord,
} from "./types.js";
import { getMemoryStoreDirectory } from "./session-store.js";

export class InMemoryMemoryItemStore implements MemoryItemStore {
  private readonly records: QueryMemoryItemRecord[] = [];

  async insert(
    context: MemoryContext,
    item: QueryMemoryItemCandidate,
  ): Promise<void> {
    const now = new Date().toISOString();
    this.records.push({
      id: randomUUID(),
      userId: context.userId,
      agentId: context.agentId,
      scope: item.scope,
      query: item.query,
      summary: item.summary,
      content: item.content,
      importance: item.importance,
      confidence: item.confidence,
      source: item.source,
      createdAt: now,
      updatedAt: now,
    });
    console.log(
      `[memory:items:store] store=in-memory user=${context.userId} agent=${context.agentId} session=${context.sessionId} query=${JSON.stringify(truncate(item.query, 160))}`,
    );
  }

  async searchRelevant(
    context: MemoryContext,
    query: string,
    options: { limit: number },
  ): Promise<QueryMemoryItemRecord[]> {
    const results = searchRecords(this.records, context, query, options.limit);
    console.log(
      `[memory:items:search] store=in-memory user=${context.userId} agent=${context.agentId} session=${context.sessionId} count=${results.length} limit=${options.limit} query=${JSON.stringify(truncate(query, 160))}`,
    );
    return results;
  }

  list(): QueryMemoryItemRecord[] {
    return [...this.records];
  }
}

export class FileBackedMemoryItemStore implements MemoryItemStore {
  constructor(
    private readonly filePath = path.join(getMemoryStoreDirectory(), "memory-items.json"),
  ) {}

  async insert(context: MemoryContext, item: QueryMemoryItemCandidate): Promise<void> {
    const records = await this.readAll();
    const now = new Date().toISOString();
    records.push({
      id: randomUUID(),
      userId: context.userId,
      agentId: context.agentId,
      scope: item.scope,
      query: item.query,
      summary: item.summary,
      content: item.content,
      importance: item.importance,
      confidence: item.confidence,
      source: item.source,
      createdAt: now,
      updatedAt: now,
    });
    await this.writeAll(records);
    console.log(
      `[memory:items:store] store=file user=${context.userId} agent=${context.agentId} session=${context.sessionId} query=${JSON.stringify(truncate(item.query, 160))}`,
    );
  }

  async searchRelevant(
    context: MemoryContext,
    query: string,
    options: { limit: number },
  ): Promise<QueryMemoryItemRecord[]> {
    const records = await this.readAll();
    const results = searchRecords(records, context, query, options.limit);
    console.log(
      `[memory:items:search] store=file user=${context.userId} agent=${context.agentId} session=${context.sessionId} count=${results.length} limit=${options.limit} query=${JSON.stringify(truncate(query, 160))}`,
    );
    return results;
  }

  private async readAll(): Promise<QueryMemoryItemRecord[]> {
    try {
      const raw = await readFile(this.filePath, "utf8");
      return JSON.parse(raw) as QueryMemoryItemRecord[];
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "ENOENT") {
        return [];
      }
      throw error;
    }
  }

  private async writeAll(records: QueryMemoryItemRecord[]): Promise<void> {
    await mkdir(path.dirname(this.filePath), { recursive: true });
    await writeFile(this.filePath, `${JSON.stringify(records, null, 2)}\n`, "utf8");
  }
}

function searchRecords(
  records: QueryMemoryItemRecord[],
  context: MemoryContext,
  query: string,
  limit: number,
): QueryMemoryItemRecord[] {
  const normalizedQuery = query.toLowerCase();
  return records
    .filter((record) => record.userId === context.userId && record.agentId === context.agentId)
    .map((record) => ({
      record,
      score: scoreRecord(record, normalizedQuery),
    }))
    .filter((item) => item.score > 0)
    .sort((left, right) => right.score - left.score)
    .slice(0, limit)
    .map(({ record }) => record);
}

function scoreRecord(record: QueryMemoryItemRecord, normalizedQuery: string): number {
  const haystack = `${record.query} ${record.summary} ${record.content}`.toLowerCase();
  const overlap = normalizedQuery
    .split(/\s+/)
    .filter(Boolean)
    .reduce((score, token) => score + (haystack.includes(token) ? 1 : 0), 0);
  return overlap * 10 + record.importance;
}

function truncate(value: string, maxLength: number): string {
  return value.length <= maxLength ? value : `${value.slice(0, maxLength)}...`;
}
