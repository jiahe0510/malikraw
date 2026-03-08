import { randomUUID } from "node:crypto";

import { Pool } from "pg";

import type {
  MemoryContext,
  MemoryScope,
  SemanticMemoryCandidate,
  SemanticMemoryRecord,
  SemanticMemoryStore,
} from "./types.js";

type Queryable = {
  query<TResult = unknown>(text: string, params?: unknown[]): Promise<{ rows: TResult[] }>;
};

export class InMemorySemanticMemoryStore implements SemanticMemoryStore {
  private readonly records = new Map<string, SemanticMemoryRecord>();

  async upsertMany(context: MemoryContext, items: SemanticMemoryCandidate[]): Promise<number> {
    let written = 0;
    for (const item of items) {
      const key = buildSemanticKey(context, item.scope, item.key);
      const existing = this.records.get(key);
      const now = new Date().toISOString();
      this.records.set(key, {
        id: existing?.id ?? randomUUID(),
        userId: context.userId,
        agentId: context.agentId,
        scope: item.scope,
        key: item.key,
        summary: item.summary,
        value: item.value,
        confidence: item.confidence,
        importance: Math.max(item.confidence, 0.5),
        source: item.source === "explicit" ? "user_explicit" : "inferred",
        content: {
          key: item.key,
          value: item.value,
        },
        createdAt: existing?.createdAt ?? now,
        updatedAt: now,
      });
      written += 1;
    }

    return written;
  }

  async listRelevant(
    context: MemoryContext,
    scopes: MemoryScope[],
    limit: number,
  ): Promise<SemanticMemoryRecord[]> {
    const allowedScopes = new Set(scopes);
    return [...this.records.values()]
      .filter((record) =>
        record.userId === context.userId
        && record.agentId === context.agentId
        && allowedScopes.has(record.scope)
      )
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
      .slice(0, limit);
  }
}

export class PostgresSemanticMemoryStore implements SemanticMemoryStore {
  constructor(private readonly db: Queryable) {}

  static fromUrl(postgresUrl: string): PostgresSemanticMemoryStore {
    return new PostgresSemanticMemoryStore(new Pool({ connectionString: postgresUrl }));
  }

  async upsertMany(context: MemoryContext, items: SemanticMemoryCandidate[]): Promise<number> {
    let written = 0;
    for (const item of items) {
      await this.db.query(
        `
          INSERT INTO memory_items (
            id, user_id, agent_id, type, scope, memory_key, summary, content,
            importance, confidence, source
          ) VALUES (
            $1, $2, $3, 'semantic', $4, $5, $6, $7::jsonb,
            $8, $9, $10
          )
          ON CONFLICT (user_id, agent_id, type, scope, memory_key)
          DO UPDATE SET
            summary = EXCLUDED.summary,
            content = EXCLUDED.content,
            importance = EXCLUDED.importance,
            confidence = EXCLUDED.confidence,
            source = EXCLUDED.source,
            updated_at = now()
        `,
        [
          randomUUID(),
          context.userId,
          context.agentId,
          item.scope,
          item.key,
          item.summary,
          JSON.stringify({
            key: item.key,
            value: item.value,
          }),
          Math.max(item.confidence, 0.5),
          item.confidence,
          item.source === "explicit" ? "user_explicit" : "inferred",
        ],
      );
      written += 1;
    }

    return written;
  }

  async listRelevant(
    context: MemoryContext,
    scopes: MemoryScope[],
    limit: number,
  ): Promise<SemanticMemoryRecord[]> {
    const result = await this.db.query<{
      id: string;
      user_id: string;
      agent_id: string;
      scope: MemoryScope;
      memory_key: string;
      summary: string;
      content: Record<string, unknown>;
      importance: number;
      confidence: number;
      source: SemanticMemoryRecord["source"];
      created_at: string;
      updated_at: string;
    }>(
      `
        SELECT
          id, user_id, agent_id, scope, memory_key, summary, content,
          importance, confidence, source, created_at, updated_at
        FROM memory_items
        WHERE user_id = $1
          AND agent_id = $2
          AND type = 'semantic'
          AND scope = ANY($3::text[])
        ORDER BY importance DESC, updated_at DESC
        LIMIT $4
      `,
      [context.userId, context.agentId, scopes, limit],
    );

    return result.rows.map((row) => ({
      id: row.id,
      userId: row.user_id,
      agentId: row.agent_id,
      scope: row.scope,
      key: row.memory_key,
      summary: row.summary,
      value: (row.content.value as string | boolean | number | undefined) ?? row.summary,
      confidence: Number(row.confidence ?? 0),
      importance: Number(row.importance ?? 0),
      source: row.source,
      content: row.content,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    }));
  }
}

function buildSemanticKey(
  context: Pick<MemoryContext, "userId" | "agentId">,
  scope: MemoryScope,
  key: string,
): string {
  return `${context.userId}:${context.agentId}:${scope}:${key}`;
}
