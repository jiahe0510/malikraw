import { randomUUID } from "node:crypto";

import { Pool } from "pg";

import type {
  MemoryContext,
  MemoryItemStore,
  QueryMemoryItemCandidate,
  QueryMemoryItemRecord,
} from "./types.js";

type Queryable = {
  query<TResult = unknown>(text: string, params?: unknown[]): Promise<{ rows: TResult[] }>;
};

export class InMemoryMemoryItemStore implements MemoryItemStore {
  private readonly records: QueryMemoryItemRecord[] = [];

  async insert(
    context: MemoryContext,
    item: QueryMemoryItemCandidate,
    _embedding?: number[],
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
    options: { limit: number; embedding?: number[] },
  ): Promise<QueryMemoryItemRecord[]> {
    const normalizedQuery = query.toLowerCase();
    const results = this.records
      .filter((record) => record.userId === context.userId && record.agentId === context.agentId)
      .map((record) => ({
        record,
        score: scoreRecord(record, normalizedQuery),
      }))
      .filter((item) => item.score > 0)
      .sort((left, right) => right.score - left.score)
      .slice(0, options.limit)
      .map(({ record }) => record);
    console.log(
      `[memory:items:search] store=in-memory user=${context.userId} agent=${context.agentId} session=${context.sessionId} count=${results.length} limit=${options.limit} query=${JSON.stringify(truncate(query, 160))}`,
    );
    return results;
  }

  list(): QueryMemoryItemRecord[] {
    return [...this.records];
  }
}

export class PostgresMemoryItemStore implements MemoryItemStore {
  private vectorSupport?: boolean;

  constructor(private readonly db: Queryable) {}

  static fromUrl(postgresUrl: string): PostgresMemoryItemStore {
    return new PostgresMemoryItemStore(new Pool({ connectionString: postgresUrl }));
  }

  async insert(
    context: MemoryContext,
    item: QueryMemoryItemCandidate,
    embedding?: number[],
  ): Promise<void> {
    if (embedding && await this.supportsVector()) {
      await this.db.query(
        `
          INSERT INTO memory_items (
            id, user_id, agent_id, type, scope, query, summary, content,
            query_embedding_json, query_embedding, importance, confidence, source
          ) VALUES (
            $1, $2, $3, 'memory', $4, $5, $6, $7::jsonb,
            $8::jsonb, $9::vector, $10, $11, $12
          )
        `,
        [
          randomUUID(),
          context.userId,
          context.agentId,
          item.scope,
          item.query,
          item.summary,
          JSON.stringify({ text: item.content }),
          JSON.stringify(embedding),
          toVectorLiteral(embedding),
          item.importance,
          item.confidence,
          item.source,
        ],
      );
    } else {
      await this.db.query(
        `
          INSERT INTO memory_items (
            id, user_id, agent_id, type, scope, query, summary, content,
            query_embedding_json, importance, confidence, source
          ) VALUES (
            $1, $2, $3, 'memory', $4, $5, $6, $7::jsonb,
            $8::jsonb, $9, $10, $11
          )
        `,
        [
          randomUUID(),
          context.userId,
          context.agentId,
          item.scope,
          item.query,
          item.summary,
          JSON.stringify({ text: item.content }),
          embedding ? JSON.stringify(embedding) : null,
          item.importance,
          item.confidence,
          item.source,
        ],
      );
    }
    console.log(
      `[memory:items:store] store=postgres user=${context.userId} agent=${context.agentId} session=${context.sessionId} query=${JSON.stringify(truncate(item.query, 160))}`,
    );
  }

  async searchRelevant(
    context: MemoryContext,
    query: string,
    options: { limit: number; embedding?: number[] },
  ): Promise<QueryMemoryItemRecord[]> {
    const vectorEnabled = Boolean(options.embedding) && await this.supportsVector();
    const result = vectorEnabled
      ? await this.db.query<DbRow>(
        `
          SELECT
            id, user_id, agent_id, scope, query, summary, content,
            importance, confidence, source, created_at, updated_at
          FROM memory_items
          WHERE user_id = $1
            AND agent_id = $2
            AND type = 'memory'
          ORDER BY query_embedding <=> $3::vector, importance DESC, updated_at DESC
          LIMIT $4
        `,
        [context.userId, context.agentId, toVectorLiteral(options.embedding!), options.limit],
      )
      : await this.db.query<DbRow>(
        `
          SELECT
            id, user_id, agent_id, scope, query, summary, content,
            importance, confidence, source, created_at, updated_at
          FROM memory_items
          WHERE user_id = $1
            AND agent_id = $2
            AND type = 'memory'
            AND (
              query ILIKE $3
              OR summary ILIKE $3
              OR content::text ILIKE $3
            )
          ORDER BY importance DESC, updated_at DESC
          LIMIT $4
        `,
        [context.userId, context.agentId, `%${query}%`, options.limit],
      );
    console.log(
      `[memory:items:search] store=postgres user=${context.userId} agent=${context.agentId} session=${context.sessionId} mode=${vectorEnabled ? "vector" : "text"} count=${result.rows.length} limit=${options.limit} query=${JSON.stringify(truncate(query, 160))}`,
    );
    return result.rows.map((row) => ({
      id: row.id,
      userId: row.user_id,
      agentId: row.agent_id,
      scope: row.scope,
      query: row.query,
      summary: row.summary,
      content: typeof row.content.text === "string" ? row.content.text : row.summary,
      importance: Number(row.importance ?? 0),
      confidence: Number(row.confidence ?? 0),
      source: row.source,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    }));
  }

  private async supportsVector(): Promise<boolean> {
    if (this.vectorSupport !== undefined) {
      return this.vectorSupport;
    }

    const result = await this.db.query<{ present: boolean }>(`
      SELECT EXISTS (
        SELECT 1
        FROM information_schema.columns
        WHERE table_name = 'memory_items'
          AND column_name = 'query_embedding'
      ) AS present
    `);
    this.vectorSupport = Boolean(result.rows[0]?.present);
    return this.vectorSupport;
  }
}

type DbRow = {
  id: string;
  user_id: string;
  agent_id: string;
  scope: QueryMemoryItemRecord["scope"];
  query: string;
  summary: string;
  content: Record<string, unknown>;
  importance: number;
  confidence: number;
  source: QueryMemoryItemRecord["source"];
  created_at: string;
  updated_at: string;
};

function scoreRecord(record: QueryMemoryItemRecord, normalizedQuery: string): number {
  const haystack = `${record.query} ${record.summary} ${record.content}`.toLowerCase();
  const overlap = normalizedQuery
    .split(/\s+/)
    .filter(Boolean)
    .reduce((score, token) => score + (haystack.includes(token) ? 1 : 0), 0);
  return overlap * 10 + record.importance;
}

function toVectorLiteral(values: number[]): string {
  return `[${values.join(",")}]`;
}

function truncate(value: string, maxLength: number): string {
  return value.length <= maxLength ? value : `${value.slice(0, maxLength)}...`;
}
