import { Pool } from "pg";

import { MEMORY_BASE_MIGRATION_SQL, MEMORY_VECTOR_MIGRATION_SQL } from "./migration-sql.js";

export async function runMemoryMigrations(postgresUrl: string, embeddingDimensions = 1536): Promise<void> {
  const pool = new Pool({ connectionString: postgresUrl });
  try {
    for (const statement of splitSqlStatements(MEMORY_BASE_MIGRATION_SQL)) {
      await pool.query(statement);
    }
    await ensureSemanticConflictIndex(pool);

    if (await isVectorExtensionAvailable(pool)) {
      for (const statement of splitSqlStatements(MEMORY_VECTOR_MIGRATION_SQL)) {
        await pool.query(statement);
      }
      await ensureVectorColumn(pool, embeddingDimensions);
      console.log(`[memory:migrate] pgvector available; vector column enabled dims=${embeddingDimensions}`);
    } else {
      console.log("[memory:migrate] pgvector unavailable; using JSON/text episodic retrieval fallback");
    }
  } finally {
    await pool.end();
  }
}

function splitSqlStatements(sql: string): string[] {
  return sql
    .split(/;\s*\n/g)
    .map((statement) => statement.trim())
    .filter(Boolean)
    .map((statement) => `${statement};`);
}

async function isVectorExtensionAvailable(pool: Pool): Promise<boolean> {
  const result = await pool.query<{ exists: boolean }>(`
    SELECT EXISTS (
      SELECT 1
      FROM pg_available_extensions
      WHERE name = 'vector'
    ) AS exists
  `);

  return Boolean(result.rows[0]?.exists);
}

async function ensureSemanticConflictIndex(pool: Pool): Promise<void> {
  await pool.query(`DROP INDEX IF EXISTS memory_items_semantic_key_idx;`);
  await pool.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS memory_items_unique_key_idx
      ON memory_items (user_id, agent_id, type, scope, memory_key);
  `);
}

async function ensureVectorColumn(pool: Pool, embeddingDimensions: number): Promise<void> {
  const dimension = Math.trunc(embeddingDimensions);
  if (!Number.isFinite(dimension) || dimension <= 0) {
    throw new Error(`Invalid embeddingDimensions=${embeddingDimensions}. Expected a positive integer.`);
  }

  const existing = await pool.query<{ formatted_type: string }>(`
    SELECT pg_catalog.format_type(a.atttypid, a.atttypmod) AS formatted_type
    FROM pg_attribute a
    JOIN pg_class c ON a.attrelid = c.oid
    JOIN pg_namespace n ON c.relnamespace = n.oid
    WHERE n.nspname = current_schema()
      AND c.relname = 'memory_items'
      AND a.attname = 'embedding'
      AND NOT a.attisdropped
  `);

  const formattedType = existing.rows[0]?.formatted_type;
  if (!formattedType) {
    await pool.query(`ALTER TABLE memory_items ADD COLUMN embedding VECTOR(${dimension});`);
  } else {
    const existingDimensions = parseVectorDimensions(formattedType);
    if (!existingDimensions) {
      throw new Error(`memory_items.embedding has unexpected type "${formattedType}".`);
    }
    if (existingDimensions !== dimension) {
      throw new Error(
        `memory_items.embedding uses vector(${existingDimensions}) but memory.embeddingDimensions=${dimension}. `
        + "Update the config to match, or migrate the column before restarting the service.",
      );
    }
  }

  await pool.query(`
    CREATE INDEX IF NOT EXISTS memory_items_embedding_idx
      ON memory_items
      USING hnsw (embedding vector_cosine_ops)
      WHERE type = 'episode' AND embedding IS NOT NULL;
  `);
}

function parseVectorDimensions(formattedType: string): number | undefined {
  const match = formattedType.match(/^vector\((\d+)\)$/);
  if (!match) {
    return undefined;
  }

  return Number.parseInt(match[1], 10);
}
