export const MEMORY_BASE_MIGRATION_SQL = `
CREATE TABLE IF NOT EXISTS memory_items (
  id UUID PRIMARY KEY,
  user_id TEXT NOT NULL,
  agent_id TEXT NOT NULL,
  type TEXT NOT NULL,
  scope TEXT NOT NULL,
  memory_key TEXT,
  summary TEXT NOT NULL,
  content JSONB NOT NULL,
  embedding_json JSONB,
  importance REAL DEFAULT 0,
  confidence REAL DEFAULT 0,
  source TEXT,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS memory_items_unique_key_idx
  ON memory_items (user_id, agent_id, type, scope, memory_key);

CREATE INDEX IF NOT EXISTS memory_items_lookup_idx
  ON memory_items (user_id, agent_id, type, scope, updated_at DESC);

CREATE TABLE IF NOT EXISTS session_state (
  session_id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  agent_id TEXT NOT NULL,
  state JSONB NOT NULL,
  updated_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE IF NOT EXISTS memory_tool_chain (
  id UUID PRIMARY KEY,
  user_id TEXT NOT NULL,
  agent_id TEXT NOT NULL,
  session_id TEXT NOT NULL,
  project_id TEXT,
  query TEXT NOT NULL,
  assistant_response TEXT NOT NULL,
  tool_chain JSONB NOT NULL,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS memory_tool_chain_lookup_idx
  ON memory_tool_chain (user_id, agent_id, session_id, created_at DESC);
`;

export const MEMORY_VECTOR_MIGRATION_SQL = `
CREATE EXTENSION IF NOT EXISTS vector;
`;
