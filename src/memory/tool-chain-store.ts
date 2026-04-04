import { randomUUID } from "node:crypto";
import path from "node:path";

import { readJsonFile, withFileLock, writeJsonFileAtomic } from "./file-store.js";
import { recordRuntimeObservation } from "../core/observability/observability.js";
import type { MemoryContext, ToolChainMemoryRecord, ToolChainMemoryStore, ToolChainStep } from "./types.js";
import { getMemoryStoreDirectory } from "./session-store.js";

export class InMemoryToolChainMemoryStore implements ToolChainMemoryStore {
  private readonly records: ToolChainMemoryRecord[] = [];

  async insert(
    context: MemoryContext,
    input: {
      query: string;
      assistantResponse: string;
      toolChain: ToolChainStep[];
    },
  ): Promise<void> {
    const now = new Date().toISOString();
    this.records.push({
      id: randomUUID(),
      userId: context.userId,
      agentId: context.agentId,
      sessionId: context.sessionId,
      projectId: context.projectId,
      query: input.query,
      assistantResponse: input.assistantResponse,
      toolChain: input.toolChain,
      createdAt: now,
      updatedAt: now,
    });
    recordRuntimeObservation({
      name: "memory.tool_chain.save",
      message: "Stored a reusable tool chain.",
      data: {
        store: "in-memory",
        userId: context.userId,
        agentId: context.agentId,
        sessionId: context.sessionId,
        steps: input.toolChain.length,
        query: truncate(input.query, 160),
      },
    });
  }

  list(): ToolChainMemoryRecord[] {
    return [...this.records];
  }

  async searchRelevant(
    context: MemoryContext,
    query: string,
    options: { limit: number },
  ): Promise<ToolChainMemoryRecord[]> {
    const results = searchRecords(this.records, context, query, options.limit);
    recordRuntimeObservation({
      name: "memory.tool_chain.search",
      message: "Searched reusable tool chains.",
      data: {
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
}

export class FileBackedToolChainMemoryStore implements ToolChainMemoryStore {
  constructor(
    private readonly filePath = path.join(getMemoryStoreDirectory(), "memory-tool-chain.json"),
  ) {}

  async insert(
    context: MemoryContext,
    input: {
      query: string;
      assistantResponse: string;
      toolChain: ToolChainStep[];
    },
  ): Promise<void> {
    await withFileLock(this.filePath, async () => {
      const records = await this.readAll();
      const now = new Date().toISOString();
      records.push({
        id: randomUUID(),
        userId: context.userId,
        agentId: context.agentId,
        sessionId: context.sessionId,
        projectId: context.projectId,
        query: input.query,
        assistantResponse: input.assistantResponse,
        toolChain: input.toolChain,
        createdAt: now,
        updatedAt: now,
      });
      await this.writeAll(records);
    });
    recordRuntimeObservation({
      name: "memory.tool_chain.save",
      message: "Stored a reusable tool chain.",
      data: {
        store: "file",
        userId: context.userId,
        agentId: context.agentId,
        sessionId: context.sessionId,
        steps: input.toolChain.length,
        query: truncate(input.query, 160),
      },
    });
  }

  async searchRelevant(
    context: MemoryContext,
    query: string,
    options: { limit: number },
  ): Promise<ToolChainMemoryRecord[]> {
    const records = await this.readAll();
    const results = searchRecords(records, context, query, options.limit);
    recordRuntimeObservation({
      name: "memory.tool_chain.search",
      message: "Searched reusable tool chains.",
      data: {
        store: "file",
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

  private async readAll(): Promise<ToolChainMemoryRecord[]> {
    return readJsonFile(this.filePath, []);
  }

  private async writeAll(records: ToolChainMemoryRecord[]): Promise<void> {
    await writeJsonFileAtomic(this.filePath, records);
  }
}

function searchRecords(
  records: ToolChainMemoryRecord[],
  context: MemoryContext,
  query: string,
  limit: number,
): ToolChainMemoryRecord[] {
  const normalizedQuery = query.toLowerCase();
  return records
    .filter((record) => record.userId === context.userId && record.agentId === context.agentId)
    .map((record) => ({
      record,
      score: scoreToolChain(record, normalizedQuery),
    }))
    .filter((item) => item.score > 0)
    .sort((left, right) => right.score - left.score)
    .slice(0, limit)
    .map(({ record }) => record);
}

function scoreToolChain(record: ToolChainMemoryRecord, normalizedQuery: string): number {
  const haystack = `${record.query} ${record.assistantResponse} ${record.toolChain.map((step) => step.toolName).join(" ")}`
    .toLowerCase();
  const overlap = normalizedQuery
    .split(/\s+/)
    .filter(Boolean)
    .reduce((score, token) => score + (haystack.includes(token) ? 1 : 0), 0);
  return overlap * 10 + record.toolChain.length;
}

function truncate(value: string, maxLength: number): string {
  return value.length <= maxLength ? value : `${value.slice(0, maxLength)}...`;
}
