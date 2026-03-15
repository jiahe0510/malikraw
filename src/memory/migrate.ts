import { Pool } from "pg";

import { MEMORY_BASE_MIGRATION_SQL, MEMORY_VECTOR_MIGRATION_SQL } from "./migration-sql.js";

export async function runMemoryMigrations(postgresUrl: string, embeddingDimensions = 1536): Promise<void> {
  const pool = new Pool({ connectionString: postgresUrl });
  try {
    for (const statement of splitSqlStatements(MEMORY_BASE_MIGRATION_SQL)) {
      await pool.query(statement);
    }
    await ensureQueryColumns(pool);

    if (await isVectorExtensionAvailable(pool)) {
      for (const statement of splitSqlStatements(MEMORY_VECTOR_MIGRATION_SQL)) {
        await pool.query(statement);
      }
      await ensureVectorColumns(pool, embeddingDimensions);
      console.log(`[memory:migrate] pgvector available; vector column enabled dims=${embeddingDimensions}`);
    } else {
      console.log("[memory:migrate] pgvector unavailable; using JSON/text query retrieval fallback");
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

async function ensureQueryColumns(pool: Pool): Promise<void> {
  await pool.query(`ALTER TABLE memory_items ADD COLUMN IF NOT EXISTS query TEXT;`);
  await pool.query(`ALTER TABLE memory_items ADD COLUMN IF NOT EXISTS query_embedding_json JSONB;`);
  await pool.query(`ALTER TABLE memory_tool_chain ADD COLUMN IF NOT EXISTS query_embedding_json JSONB;`);
  await pool.query(`
    CREATE INDEX IF NOT EXISTS memory_items_query_lookup_idx
      ON memory_items (user_id, agent_id, type, updated_at DESC);
  `);
  await pool.query(`
    CREATE INDEX IF NOT EXISTS memory_tool_chain_query_lookup_idx
      ON memory_tool_chain (user_id, agent_id, updated_at DESC);
  `);
}

async function ensureVectorColumns(pool: Pool, embeddingDimensions: number): Promise<void> {
  const dimension = Math.trunc(embeddingDimensions);
  if (!Number.isFinite(dimension) || dimension <= 0) {
    throw new Error(`Invalid embeddingDimensions=${embeddingDimensions}. Expected a positive integer.`);
  }

  const memoryItemsType = await getVectorColumnType(pool, "memory_items", "query_embedding");
  if (!memoryItemsType) {
    await pool.query(`ALTER TABLE memory_items ADD COLUMN query_embedding VECTOR(${dimension});`);
  } else {
    assertVectorDimensions(memoryItemsType, dimension, "memory_items.query_embedding");
  }

  const toolChainType = await getVectorColumnType(pool, "memory_tool_chain", "query_embedding");
  if (!toolChainType) {
    await pool.query(`ALTER TABLE memory_tool_chain ADD COLUMN query_embedding VECTOR(${dimension});`);
  } else {
    assertVectorDimensions(toolChainType, dimension, "memory_tool_chain.query_embedding");
  }

  await pool.query(`
    CREATE INDEX IF NOT EXISTS memory_items_query_embedding_idx
      ON memory_items
      USING hnsw (query_embedding vector_cosine_ops)
      WHERE type = 'memory' AND query_embedding IS NOT NULL;
  `);
  await pool.query(`
    CREATE INDEX IF NOT EXISTS memory_tool_chain_query_embedding_idx
      ON memory_tool_chain
      USING hnsw (query_embedding vector_cosine_ops)
      WHERE query_embedding IS NOT NULL;
  `);
}

async function getVectorColumnType(pool: Pool, tableName: string, columnName: string): Promise<string | undefined> {
  const existing = await pool.query<{ formatted_type: string }>(`
    SELECT pg_catalog.format_type(a.atttypid, a.atttypmod) AS formatted_type
    FROM pg_attribute a
    JOIN pg_class c ON a.attrelid = c.oid
    JOIN pg_namespace n ON c.relnamespace = n.oid
    WHERE n.nspname = current_schema()
      AND c.relname = $1
      AND a.attname = $2
      AND NOT a.attisdropped
  `, [tableName, columnName]);
  return existing.rows[0]?.formatted_type;
}

function assertVectorDimensions(formattedType: string, dimension: number, label: string): void {
  const existingDimensions = parseVectorDimensions(formattedType);
  if (!existingDimensions) {
    throw new Error(`${label} has unexpected type "${formattedType}".`);
  }
  if (existingDimensions !== dimension) {
    throw new Error(
      `${label} uses vector(${existingDimensions}) but memory.embeddingDimensions=${dimension}. `
      + "Update the config to match, or migrate the column before restarting the service.",
    );
  }
}

function parseVectorDimensions(formattedType: string): number | undefined {
  const match = formattedType.match(/^vector\((\d+)\)$/);
  if (!match) {
    return undefined;
  }

  return Number.parseInt(match[1], 10);
}
