CREATE EXTENSION IF NOT EXISTS vector;
CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS memory_items (
  id UUID PRIMARY KEY,
  user_id TEXT NOT NULL,
  agent_id TEXT NOT NULL,
  type TEXT NOT NULL,
  scope TEXT NOT NULL,
  memory_key TEXT,
  summary TEXT NOT NULL,
  content JSONB NOT NULL,
  embedding VECTOR(1536),
  importance REAL DEFAULT 0,
  confidence REAL DEFAULT 0,
  source TEXT,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS memory_items_semantic_key_idx
  ON memory_items (user_id, agent_id, type, scope, memory_key)
  WHERE type = 'semantic';

CREATE INDEX IF NOT EXISTS memory_items_lookup_idx
  ON memory_items (user_id, agent_id, type, scope, updated_at DESC);

CREATE INDEX IF NOT EXISTS memory_items_embedding_idx
  ON memory_items
  USING hnsw (embedding vector_cosine_ops)
  WHERE type = 'episode' AND embedding IS NOT NULL;

CREATE TABLE IF NOT EXISTS session_state (
  session_id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  agent_id TEXT NOT NULL,
  state JSONB NOT NULL,
  updated_at TIMESTAMPTZ DEFAULT now()
);
