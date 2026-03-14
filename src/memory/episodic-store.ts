import { randomUUID } from "node:crypto";

import { Pool } from "pg";

import type {
  EpisodicMemoryCandidate,
  EpisodicMemoryRecord,
  EpisodicMemoryStore,
  MemoryContext,
} from "./types.js";

type Queryable = {
  query<TResult = unknown>(text: string, params?: unknown[]): Promise<{ rows: TResult[] }>;
};

export class InMemoryEpisodicMemoryStore implements EpisodicMemoryStore {
  private readonly records: EpisodicMemoryRecord[] = [];

  async insert(
    context: MemoryContext,
    episode: EpisodicMemoryCandidate,
    embedding?: number[],
  ): Promise<void> {
    const now = new Date().toISOString();
    this.records.push({
      id: randomUUID(),
      userId: context.userId,
      agentId: context.agentId,
      scope: context.projectId ? "project" : "session",
      summary: episode.summary,
      entities: episode.entities,
      importance: episode.importance,
      confidence: episode.confidence ?? 0.75,
      source: episode.source ?? "task_summary",
      content: episode.content ?? {
        entities: episode.entities,
      },
      embedding,
      createdAt: now,
      updatedAt: now,
    });
  }

  async searchRelevant(
    context: MemoryContext,
    query: string,
    options: { limit: number; embedding?: number[] },
  ): Promise<EpisodicMemoryRecord[]> {
    const normalizedQuery = query.toLowerCase();
    return this.records
      .filter((record) => record.userId === context.userId && record.agentId === context.agentId)
      .map((record) => ({
        record,
        score: scoreEpisode(record, normalizedQuery),
      }))
      .sort((left, right) => right.score - left.score)
      .slice(0, options.limit)
      .map(({ record }) => record);
  }
}

export class PostgresEpisodicMemoryStore implements EpisodicMemoryStore {
  private vectorSupport?: boolean;

  constructor(private readonly db: Queryable) {}

  static fromUrl(postgresUrl: string): PostgresEpisodicMemoryStore {
    return new PostgresEpisodicMemoryStore(new Pool({ connectionString: postgresUrl }));
  }

  async insert(
    context: MemoryContext,
    episode: EpisodicMemoryCandidate,
    embedding?: number[],
  ): Promise<void> {
    if (embedding && await this.supportsVector()) {
      await this.db.query(
        `
          INSERT INTO memory_items (
            id, user_id, agent_id, type, scope, summary, content, embedding_json, embedding,
            importance, confidence, source
          ) VALUES (
            $1, $2, $3, 'episode', $4, $5, $6::jsonb, $7::jsonb, $8::vector,
            $9, $10, $11
          )
        `,
        [
          randomUUID(),
          context.userId,
          context.agentId,
          context.projectId ? "project" : "session",
          episode.summary,
          JSON.stringify(episode.content ?? {
            entities: episode.entities,
          }),
          JSON.stringify(embedding),
          toVectorLiteral(embedding),
          episode.importance,
          episode.confidence ?? 0.75,
          episode.source ?? "task_summary",
        ],
      );
      return;
    }

    await this.db.query(
      `
        INSERT INTO memory_items (
          id, user_id, agent_id, type, scope, summary, content, embedding_json,
          importance, confidence, source
        ) VALUES (
          $1, $2, $3, 'episode', $4, $5, $6::jsonb, $7::jsonb,
          $8, $9, $10
        )
      `,
      [
        randomUUID(),
        context.userId,
        context.agentId,
        context.projectId ? "project" : "session",
        episode.summary,
        JSON.stringify(episode.content ?? {
          entities: episode.entities,
        }),
        embedding ? JSON.stringify(embedding) : null,
        episode.importance,
        episode.confidence ?? 0.75,
        episode.source ?? "task_summary",
      ],
    );
  }

  async searchRelevant(
    context: MemoryContext,
    query: string,
    options: { limit: number; embedding?: number[] },
  ): Promise<EpisodicMemoryRecord[]> {
    const result = options.embedding && await this.supportsVector()
      ? await this.db.query<DbEpisodeRow>(
        `
          SELECT
            id, user_id, agent_id, scope, summary, content, importance, confidence,
            source, created_at, updated_at
          FROM memory_items
          WHERE user_id = $1
            AND agent_id = $2
            AND type = 'episode'
          ORDER BY embedding <=> $3::vector, importance DESC, updated_at DESC
          LIMIT $4
        `,
        [context.userId, context.agentId, toVectorLiteral(options.embedding), options.limit],
      )
      : await this.db.query<DbEpisodeRow>(
        `
          SELECT
            id, user_id, agent_id, scope, summary, content, importance, confidence,
            source, created_at, updated_at
          FROM memory_items
          WHERE user_id = $1
            AND agent_id = $2
            AND type = 'episode'
            AND (
              summary ILIKE $3
              OR content::text ILIKE $3
            )
          ORDER BY importance DESC, updated_at DESC
          LIMIT $4
        `,
        [context.userId, context.agentId, `%${query}%`, options.limit],
      );

    return result.rows.map((row) => ({
      id: row.id,
      userId: row.user_id,
      agentId: row.agent_id,
      scope: row.scope,
      summary: row.summary,
      entities: Array.isArray(row.content.entities) ? row.content.entities as string[] : [],
      importance: Number(row.importance ?? 0),
      confidence: Number(row.confidence ?? 0),
      source: row.source,
      content: row.content,
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
          AND column_name = 'embedding'
      ) AS present
    `);
    this.vectorSupport = Boolean(result.rows[0]?.present);
    return this.vectorSupport;
  }
}

type DbEpisodeRow = {
  id: string;
  user_id: string;
  agent_id: string;
  scope: EpisodicMemoryRecord["scope"];
  summary: string;
  content: Record<string, unknown>;
  importance: number;
  confidence: number;
  source: EpisodicMemoryRecord["source"];
  created_at: string;
  updated_at: string;
};

function scoreEpisode(record: EpisodicMemoryRecord, normalizedQuery: string): number {
  const haystack = `${record.summary} ${record.entities.join(" ")}`.toLowerCase();
  const overlap = normalizedQuery
    .split(/\s+/)
    .filter(Boolean)
    .reduce((score, token) => score + (haystack.includes(token) ? 1 : 0), 0);
  return overlap * 10 + record.importance;
}

function toVectorLiteral(values: number[]): string {
  return `[${values.join(",")}]`;
}
