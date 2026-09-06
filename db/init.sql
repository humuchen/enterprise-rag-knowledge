-- Enable pgvector extension
CREATE EXTENSION IF NOT EXISTS vector;

-- Documents table
CREATE TABLE IF NOT EXISTS documents (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    source      TEXT NOT NULL,
    title       TEXT,
    metadata    JSONB DEFAULT '{}',
    created_at  TIMESTAMPTZ DEFAULT NOW()
);

-- Chunks with embeddings
CREATE TABLE IF NOT EXISTS chunks (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    doc_id      UUID REFERENCES documents(id) ON DELETE CASCADE,
    content     TEXT NOT NULL,
    hash        TEXT UNIQUE,
    metadata    JSONB DEFAULT '{}',
    embedding   VECTOR(1024),
    access_tags TEXT[] DEFAULT '{}',
    created_at  TIMESTAMPTZ DEFAULT NOW(),
    updated_at  TIMESTAMPTZ DEFAULT NOW()
);

-- Indexes for performance
CREATE INDEX IF NOT EXISTS chunks_embedding_idx ON chunks USING ivfflat (embedding vector_ip) WITH (lists = 100);
CREATE INDEX IF NOT EXISTS chunks_hash_idx ON chunks(hash);
CREATE INDEX IF NOT EXISTS chunks_access_tags_idx ON chunks USING GIN (access_tags);
CREATE INDEX IF NOT EXISTS chunks_doc_id_idx ON chunks(doc_id);

-- Full-text search index (for BM25 hybrid search)
CREATE INDEX IF NOT EXISTS chunks_fts_idx ON chunks USING GIN (to_tsvector('english', content));

-- Chat history for context
CREATE TABLE IF NOT EXISTS chat_history (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    session_id  UUID NOT NULL,
    role        TEXT CHECK (role IN ('user', 'assistant')) NOT NULL,
    content     TEXT NOT NULL,
    sources     JSONB,
    created_at  TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS chat_history_session_idx ON chat_history(session_id);

-- Audit log
CREATE TABLE IF NOT EXISTS audit_log (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id     TEXT,
    action      TEXT NOT NULL,
    doc_id      UUID REFERENCES documents(id),
    query       TEXT,
    retrieved_ids UUID[],
    response    TEXT,
    latency_ms  INT,
    created_at  TIMESTAMPTZ DEFAULT NOW()
);

-- Schema migrations tracking
CREATE TABLE IF NOT EXISTS _schema_migrations (
    version TEXT PRIMARY KEY,
    migrated_at TIMESTAMPTZ DEFAULT NOW()
);
