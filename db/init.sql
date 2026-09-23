-- Enable pgvector extension
CREATE EXTENSION IF NOT EXISTS vector;

-- 加密列所需：pgcrypto 提供 pgp_sym_encrypt / pgp_sym_decrypt（OpenPGP CFB）。
-- 与 src/crypto.ts 的应用层 AES-256-GCM（content_enc）互为独立的第二层，
-- 用于「即使应用进程被攻破 / 直接读库（备份、只读副本、SQL 注入）也看不到明文」。
CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- Documents table
CREATE TABLE IF NOT EXISTS documents (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    source      TEXT NOT NULL,
    title       TEXT,
    metadata    JSONB DEFAULT '{}',
    owner_id    TEXT,
    created_at  TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS documents_owner_idx ON documents(owner_id);

-- Chunks with embeddings
-- hash 只在单个文档内唯一：全局唯一会让不同文档中的相同段落被静默丢弃。
CREATE TABLE IF NOT EXISTS chunks (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    doc_id      UUID REFERENCES documents(id) ON DELETE CASCADE,
    content     TEXT,
    search_text TEXT,
    hash        TEXT NOT NULL,
    metadata    JSONB DEFAULT '{}',
    embedding   VECTOR(1024),
    access_tags TEXT[] DEFAULT '{}',
    content_enc TEXT,
    content_pgp BYTEA,
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

-- =====================================================================
-- 安全加固说明
-- =====================================================================
-- 1) 敏感内容落库加密（应用层）：content_enc 存 AES-256-GCM 密文（密钥仅服务端持有，
--    见 src/crypto.ts 与 CONTENT_ENCRYPTION_KEY 配置），含 sensitiveSpans 的切片
--    content 置 NULL、search_text 置空，库内无明文 PII。
--
-- 2) 敏感内容落库加密（数据库层 / pgcrypto）：content_pgp 存 pgp_sym_encrypt 密文，
--    与应用层 AES 互为独立第二层。解密只能经由下面的 SECURITY DEFINER 函数
--    app_pgp_decrypt()，该函数会复用 RLS 的同一套会话变量（app.current_tags /
--    app.is_superuser / app.content_key）做授权判定：
--      - 未授权会话（标签无交集且非超级用户）→ 返回 NULL，直接拿不到明文；
--      - 未注入 app.content_key（密钥缺失）→ 返回 NULL，退化为上层 content_enc 解密；
--      - 因此「直接 SELECT content_pgp」「绕过 RLS 直查」「备份 / 只读副本」均无法得到明文。
--
-- 3) 行级安全（RLS）：chunks 表的 FOR SELECT 策略由 db/migrate.ts 在
--    DB_RLS_ENABLED=true 时自动建立（见 migrate.ts applyRlsPolicy），无需手动执行。
--    策略内容：
--      CREATE POLICY chunks_principal_select ON chunks FOR SELECT
--        USING ( current_setting('app.is_superuser','off')='on'
--                OR access_tags && string_to_array(current_setting('app.current_tags',''), ',') );
--    会话变量由 src/db.ts 的 queryWithAccess 在受控事务内通过
--    set_config('app.current_tags'/'app.is_superuser'/'app.content_key', ..., true) 注入
--    （事务级本地，不泄漏到连接池其它请求）。
--    RLS 为 fail-closed：未注入会话变量时所有 chunks 读取被拒绝。
--     prerequisites：PostgreSQL >= 9.2（自定义带点 GUC 占位符支持）。
-- =====================================================================

-- 数据库层授权解密函数（SECURITY DEFINER）：把 RLS 的授权判定下沉到解密动作本身，
-- 即使绕过 RLS 直查，未授权会话也只能拿到 NULL。密钥取自会话变量 app.content_key
-- （由应用事务内 set_config 注入，事务级本地，库内不留存）。
-- 注意：函数本身不读取 content_pgp 列的表级权限，因此若要「强制所有读取都走函数」，
-- 可额外 REVOKE SELECT (content_pgp) ON chunks FROM 应用角色;（见部署文档第 5 节）。
CREATE OR REPLACE FUNCTION app_pgp_decrypt(enc BYTEA, row_tags TEXT[])
RETURNS TEXT
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  is_su    TEXT := current_setting('app.is_superuser', 'off');
  cur_tags TEXT := current_setting('app.current_tags', '');
  enc_key  TEXT := current_setting('app.content_key', '');
BEGIN
  IF enc IS NULL THEN
    RETURN NULL;
  END IF;
  IF enc_key = '' THEN
    -- 未注入密钥：交还上层（应用用 content_enc 自行解密），本层返回 NULL
    RETURN NULL;
  END IF;
  IF is_su = 'on' THEN
    RETURN pgp_sym_decrypt(enc, enc_key);
  END IF;
  IF row_tags && string_to_array(cur_tags, ',') THEN
    RETURN pgp_sym_decrypt(enc, enc_key);
  END IF;
  RETURN NULL;
END;
$$;
