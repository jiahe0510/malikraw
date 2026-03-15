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
}

export class PostgresToolChainMemoryStore implements ToolChainMemoryStore {
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
  ): Promise<void> {
    await this.db.query(
      `
        INSERT INTO memory_tool_chain (
          id, user_id, agent_id, session_id, project_id, query, assistant_response, tool_chain
        ) VALUES (
          $1, $2, $3, $4, $5, $6, $7, $8::jsonb
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
      ],
    );
    console.log(
      `[memory:tool-chain:store] store=postgres user=${context.userId} agent=${context.agentId} session=${context.sessionId} steps=${input.toolChain.length} query=${JSON.stringify(truncate(input.query, 160))}`,
    );
  }
}

function truncate(value: string, maxLength: number): string {
  return value.length <= maxLength ? value : `${value.slice(0, maxLength)}...`;
}
