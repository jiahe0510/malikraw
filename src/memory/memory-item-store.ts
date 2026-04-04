import { randomUUID } from "node:crypto";

import { recordRuntimeObservation } from "../core/observability/observability.js";
import { listMemoryItemMarkdownRecords, writeMemoryItemMarkdown } from "./markdown-store.js";
import type {
  MemoryContext,
  MemoryItemStore,
  QueryMemoryItemCandidate,
  QueryMemoryItemRecord,
} from "./types.js";

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
    recordRuntimeObservation({
      name: "memory.item.save",
      message: "Stored a query-indexed memory item.",
      data: {
        traceId: context.traceId,
        store: "in-memory",
        userId: context.userId,
        agentId: context.agentId,
        sessionId: context.sessionId,
        query: truncate(item.query, 160),
      },
    });
  }

  async searchRelevant(
    context: MemoryContext,
    query: string,
    options: { limit: number },
  ): Promise<QueryMemoryItemRecord[]> {
    const results = searchRecords(this.records, context, query, options.limit);
    recordRuntimeObservation({
      name: "memory.item.search",
      message: "Searched query-indexed memory items.",
      data: {
        traceId: context.traceId,
        store: "in-memory",
        userId: context.userId,
        agentId: context.agentId,
        sessionId: context.sessionId,
        count: results.length,
        limit: options.limit,
        query: truncate(query, 160),
      },
    });
    return results;
  }

  list(): QueryMemoryItemRecord[] {
    return [...this.records];
  }
}

export class FileBackedMemoryItemStore implements MemoryItemStore {
  async insert(context: MemoryContext, item: QueryMemoryItemCandidate): Promise<void> {
    const now = new Date().toISOString();
    await writeMemoryItemMarkdown({
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
    recordRuntimeObservation({
      name: "memory.item.save",
      message: "Stored a query-indexed memory item.",
      data: {
        traceId: context.traceId,
        store: "markdown",
        userId: context.userId,
        agentId: context.agentId,
        sessionId: context.sessionId,
        query: truncate(item.query, 160),
      },
    });
  }

  async searchRelevant(
    context: MemoryContext,
    query: string,
    options: { limit: number },
  ): Promise<QueryMemoryItemRecord[]> {
    const records = await listMemoryItemMarkdownRecords(context.agentId);
    const results = searchRecords(records, context, query, options.limit);
    recordRuntimeObservation({
      name: "memory.item.search",
      message: "Searched query-indexed memory items.",
      data: {
        traceId: context.traceId,
        store: "markdown",
        userId: context.userId,
        agentId: context.agentId,
        sessionId: context.sessionId,
        count: results.length,
        limit: options.limit,
        query: truncate(query, 160),
      },
    });
    return results;
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
    .filter((record) => record.agentId === context.agentId)
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
