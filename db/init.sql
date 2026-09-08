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
-- hash 只在单个文档内唯一：全局唯一会让不同文档中的相同段落被静默丢弃。
CREATE TABLE IF NOT EXISTS chunks (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    doc_id      UUID REFERENCES documents(id) ON DELETE CASCADE,
    content     TEXT NOT NULL,
    search_text TEXT,
    hash        TEXT NOT NULL,
    metadata    JSONB DEFAULT '{}',
    embedding   VECTOR(1024),
    access_tags TEXT[] DEFAULT '{}',
    source      TEXT,
    created_at  TIMESTAMPTZ DEFAULT NOW(),
    updated_at  TIMESTAMPTZ DEFAULT NOW(),
    CONSTRAINT chunks_doc_id_hash_key UNIQUE (doc_id, hash)
);

-- Indexes for performance
-- 索引算子必须与查询算子一致：retriever 用 <=> （余弦距离），
-- 因此这里必须是 vector_cosine_ops，写成 vector_ip 会导致索引失效、全表扫描。
CREATE INDEX IF NOT EXISTS chunks_embedding_idx ON chunks USING ivfflat (embedding vector_cosine_ops) WITH (lists = 100);
CREATE INDEX IF NOT EXISTS chunks_access_tags_idx ON chunks USING GIN (access_tags);
CREATE INDEX IF NOT EXISTS chunks_doc_id_idx ON chunks(doc_id);

-- Full-text search index (for BM25 hybrid search)
-- search_text 由应用层生成（中文 bigram，见 src/tokenize.ts）。
-- 使用 simple 配置：不做词干化，保证入库与查询侧的 token 完全对齐。
CREATE INDEX IF NOT EXISTS chunks_fts_idx ON chunks USING GIN (to_tsvector('simple', coalesce(search_text, '')));

-- Chat history for context
CREATE TABLE IF NOT EXISTS chat_history (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    session_id  TEXT NOT NULL,
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
