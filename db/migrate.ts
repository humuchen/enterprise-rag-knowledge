// db/migrate.ts
import { pool } from '../src/db';
import { readFileSync } from 'fs';
import path from 'path';

const SCHEMA_VERSION = '1.1.0';

async function checkMigrationsTable(): Promise<void> {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS _schema_migrations (
      version TEXT PRIMARY KEY,
      migrated_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);
}

async function isAlreadyMigrated(): Promise<boolean> {
  const res = await pool.query(
    'SELECT version FROM _schema_migrations WHERE version = $1',
    [SCHEMA_VERSION],
  );
  return res.rows.length > 0;
}

async function markMigrated(): Promise<void> {
  await pool.query(
    'INSERT INTO _schema_migrations (version) VALUES ($1) ON CONFLICT DO NOTHING',
    [SCHEMA_VERSION],
  );
}

// 对 1.0.0 建起来的库做原地升级。全部语句幂等，可重复执行。
async function applySchemaUpgrades(): Promise<void> {
  // 1. 新增中文检索列
  await pool.query(`ALTER TABLE chunks ADD COLUMN IF NOT EXISTS search_text TEXT`);

  // 2. hash 唯一键：全局唯一 -> (doc_id, hash)
  await pool.query(`
    DO $$
    BEGIN
      IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chunks_hash_key') THEN
        ALTER TABLE chunks DROP CONSTRAINT chunks_hash_key;
      END IF;
      IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chunks_doc_id_hash_key') THEN
        ALTER TABLE chunks ADD CONSTRAINT chunks_doc_id_hash_key UNIQUE (doc_id, hash);
      END IF;
    END $$;
  `);

  // 3. session_id 放宽为 TEXT，允许客户端自定义会话标识
  await pool.query(`
    DO $$
    BEGIN
      IF EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_name = 'chat_history' AND column_name = 'session_id'
          AND data_type = 'uuid'
      ) THEN
        ALTER TABLE chat_history ALTER COLUMN session_id TYPE TEXT;
      END IF;
    END $$;
  `);

  // 4. 向量索引算子修正：vector_ip 与查询用的 <=> 不匹配，索引形同虚设
  await pool.query(`
    DO $$
    BEGIN
      IF EXISTS (
        SELECT 1 FROM pg_indexes
        WHERE indexname = 'chunks_embedding_idx'
          AND indexdef NOT LIKE '%vector_cosine_ops%'
      ) THEN
        DROP INDEX chunks_embedding_idx;
      END IF;
    END $$;
  `);

  // 5. FTS 索引改为基于 search_text（旧版基于 content + english 配置，中文不可用）
  await pool.query(`
    DO $$
    BEGIN
      IF EXISTS (
        SELECT 1 FROM pg_indexes
        WHERE indexname = 'chunks_fts_idx'
          AND indexdef NOT LIKE '%search_text%'
      ) THEN
        DROP INDEX chunks_fts_idx;
      END IF;
    END $$;
  `);

  // 6. 重建/补齐索引
  await pool.query(`
    CREATE INDEX IF NOT EXISTS chunks_embedding_idx
      ON chunks USING ivfflat (embedding vector_cosine_ops) WITH (lists = 100)
  `);
  await pool.query(`
    CREATE INDEX IF NOT EXISTS chunks_fts_idx
      ON chunks USING GIN (to_tsvector('simple', coalesce(search_text, '')))
  `);
  // UNIQUE (doc_id, hash) 自带索引，旧版单独的 hash 索引已成冗余
  await pool.query(`DROP INDEX IF EXISTS chunks_hash_idx`);

  // 7. 为存量数据补齐 search_text（应用层分词，SQL 侧无法等价实现）
  const pending = await pool.query<{ cnt: string }>(
    `SELECT COUNT(*) AS cnt FROM chunks WHERE search_text IS NULL`,
  );
  const pendingCount = parseInt(pending.rows[0]?.cnt ?? '0', 10);
  if (pendingCount > 0) {
    console.log(
      `⚠️  ${pendingCount} 条存量 chunk 缺少 search_text，中文检索对其无效。` +
      `请执行 "npm run ingest -- --reindex --backfill-text" 回填。`,
    );
  }
}

async function runMigration(): Promise<void> {
  await checkMigrationsTable();

  // 1. 先确保基础表存在（init.sql 全部 IF NOT EXISTS，可重复执行）。
  //    必须在 applySchemaUpgrades 之前执行，否则对全新空库做 ALTER TABLE
  //    会报 “relation chunks does not exist”。
  const initSqlPath = path.resolve(__dirname, 'init.sql');
  const schema = readFileSync(initSqlPath, 'utf-8');
  await pool.query(schema);

  // 2. 原地升级 1.0.0 -> 1.1.0：对全新库是空操作；对旧库补齐 search_text / 修正索引 / 换唯一键。
  await applySchemaUpgrades();

  if (await isAlreadyMigrated()) {
    console.log('Already at schema version', SCHEMA_VERSION, '- skipping');
    return;
  }

  await markMigrated();
  console.log('Schema migrated to version', SCHEMA_VERSION);
}

runMigration()
  .then(() => process.exit(0))
  .catch(err => {
    console.error('Migration failed:', err.message);
    process.exit(1);
  });
