import { randomUUID } from "node:crypto";

import { Pool } from "pg";

import type { MemoryContext, ToolChainMemoryRecord, ToolChainMemoryStore, ToolChainStep } from "./types.js";

type Queryable = {
  query<TResult = unknown>(text: string, params?: unknown[]): Promise<{ rows: TResult[] }>;
};

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
    console.log(
      `[memory:tool-chain:store] store=in-memory user=${context.userId} agent=${context.agentId} session=${context.sessionId} steps=${input.toolChain.length} query=${JSON.stringify(truncate(input.query, 160))}`,
    );
  }

  list(): ToolChainMemoryRecord[] {
    return [...this.records];
  }

  async searchRelevant(
    context: MemoryContext,
    query: string,
    options: { limit: number; embedding?: number[] },
  ): Promise<ToolChainMemoryRecord[]> {
    const normalizedQuery = query.toLowerCase();
    const results = this.records
      .filter((record) => record.userId === context.userId && record.agentId === context.agentId)
      .map((record) => ({
        record,
        score: scoreToolChain(record, normalizedQuery),
      }))
      .filter((item) => item.score > 0)
      .sort((left, right) => right.score - left.score)
      .slice(0, options.limit)
      .map(({ record }) => record);
    console.log(
      `[memory:tool-chain:search] store=in-memory user=${context.userId} agent=${context.agentId} session=${context.sessionId} count=${results.length} limit=${options.limit} query=${JSON.stringify(truncate(query, 160))}`,
    );
    return results;
  }
}

export class PostgresToolChainMemoryStore implements ToolChainMemoryStore {
  private vectorSupport?: boolean;

  constructor(private readonly db: Queryable) {}

  static fromUrl(postgresUrl: string): PostgresToolChainMemoryStore {
    return new PostgresToolChainMemoryStore(new Pool({ connectionString: postgresUrl }));
  }

  async insert(
    context: MemoryContext,
    input: {
      query: string;
      assistantResponse: string;
      toolChain: ToolChainStep[];
    },
    embedding?: number[],
  ): Promise<void> {
    if (embedding && await this.supportsVector()) {
      await this.db.query(
        `
          INSERT INTO memory_tool_chain (
            id, user_id, agent_id, session_id, project_id, query, assistant_response, tool_chain,
            query_embedding_json, query_embedding
          ) VALUES (
            $1, $2, $3, $4, $5, $6, $7, $8::jsonb,
            $9::jsonb, $10::vector
          )
        `,
        [
          randomUUID(),
          context.userId,
          context.agentId,
          context.sessionId,
          context.projectId ?? null,
          input.query,
          input.assistantResponse,
          JSON.stringify(input.toolChain),
          JSON.stringify(embedding),
          toVectorLiteral(embedding),
        ],
      );
    } else {
      await this.db.query(
        `
          INSERT INTO memory_tool_chain (
            id, user_id, agent_id, session_id, project_id, query, assistant_response, tool_chain,
            query_embedding_json
          ) VALUES (
            $1, $2, $3, $4, $5, $6, $7, $8::jsonb,
            $9::jsonb
          )
        `,
        [
          randomUUID(),
          context.userId,
          context.agentId,
          context.sessionId,
          context.projectId ?? null,
          input.query,
          input.assistantResponse,
          JSON.stringify(input.toolChain),
          embedding ? JSON.stringify(embedding) : null,
        ],
      );
    }
    console.log(
      `[memory:tool-chain:store] store=postgres user=${context.userId} agent=${context.agentId} session=${context.sessionId} steps=${input.toolChain.length} query=${JSON.stringify(truncate(input.query, 160))}`,
    );
  }

  async searchRelevant(
    context: MemoryContext,
    query: string,
    options: { limit: number; embedding?: number[] },
  ): Promise<ToolChainMemoryRecord[]> {
    const vectorEnabled = Boolean(options.embedding) && await this.supportsVector();
    const result = vectorEnabled
      ? await this.db.query<DbToolChainRow>(
        `
          SELECT
            id, user_id, agent_id, session_id, project_id, query, assistant_response,
            tool_chain, created_at, updated_at
          FROM memory_tool_chain
          WHERE user_id = $1
            AND agent_id = $2
          ORDER BY query_embedding <=> $3::vector, updated_at DESC
          LIMIT $4
        `,
        [context.userId, context.agentId, toVectorLiteral(options.embedding!), options.limit],
      )
      : await this.db.query<DbToolChainRow>(
        `
          SELECT
            id, user_id, agent_id, session_id, project_id, query, assistant_response,
            tool_chain, created_at, updated_at
          FROM memory_tool_chain
          WHERE user_id = $1
            AND agent_id = $2
            AND (
              query ILIKE $3
              OR assistant_response ILIKE $3
              OR tool_chain::text ILIKE $3
            )
          ORDER BY updated_at DESC
          LIMIT $4
        `,
        [context.userId, context.agentId, `%${query}%`, options.limit],
      );
    console.log(
      `[memory:tool-chain:search] store=postgres user=${context.userId} agent=${context.agentId} session=${context.sessionId} mode=${vectorEnabled ? "vector" : "text"} count=${result.rows.length} limit=${options.limit} query=${JSON.stringify(truncate(query, 160))}`,
    );
    return result.rows.map((row) => ({
      id: row.id,
      userId: row.user_id,
      agentId: row.agent_id,
      sessionId: row.session_id,
      projectId: row.project_id ?? undefined,
      query: row.query,
      assistantResponse: row.assistant_response,
      toolChain: Array.isArray(row.tool_chain) ? row.tool_chain as ToolChainStep[] : [],
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
        WHERE table_name = 'memory_tool_chain'
          AND column_name = 'query_embedding'
      ) AS present
    `);
    this.vectorSupport = Boolean(result.rows[0]?.present);
    return this.vectorSupport;
  }
}

type DbToolChainRow = {
  id: string;
  user_id: string;
  agent_id: string;
  session_id: string;
  project_id: string | null;
  query: string;
  assistant_response: string;
  tool_chain: unknown;
  created_at: string;
  updated_at: string;
};

function scoreToolChain(record: ToolChainMemoryRecord, normalizedQuery: string): number {
  const haystack = `${record.query} ${record.assistantResponse} ${record.toolChain.map((step) => step.toolName).join(" ")}`
    .toLowerCase();
  const overlap = normalizedQuery
    .split(/\s+/)
    .filter(Boolean)
    .reduce((score, token) => score + (haystack.includes(token) ? 1 : 0), 0);
  return overlap * 10 + record.toolChain.length;
}

function toVectorLiteral(values: number[]): string {
  return `[${values.join(",")}]`;
}

function truncate(value: string, maxLength: number): string {
  return value.length <= maxLength ? value : `${value.slice(0, maxLength)}...`;
}
