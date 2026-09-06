// db/migrate.ts
import { pool } from '../src/db';
import { readFileSync } from 'fs';
import path from 'path';

const SCHEMA_VERSION = '1.0.0';

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

async function runMigration(): Promise<void> {
  await checkMigrationsTable();

  if (await isAlreadyMigrated()) {
    console.log('Already at schema version', SCHEMA_VERSION, '- skipping');
    return;
  }

  const initSqlPath = path.resolve(__dirname, 'init.sql');
  const schema = readFileSync(initSqlPath, 'utf-8');
  const statements = schema.split(';').filter(s => s.trim());

  for (const stmt of statements) {
    await pool.query(stmt.trim());
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
