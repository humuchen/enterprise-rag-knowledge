// src/db.ts
import pg from 'pg';
import Redis from 'ioredis';
import { config } from './config';

const { Pool } = pg;

export const pool = new Pool({
  connectionString: `postgresql://${config.DB_USER}:${config.DB_PASSWORD}@${config.DB_HOST}:${config.DB_PORT}/${config.DB_NAME}`,
  max: 20,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 5000,
});

export const redis: Redis = new (Redis as any)({
  host: config.REDIS_HOST,
  port: config.REDIS_PORT,
  retryStrategy: (times: number) => Math.min(times * 50, 2000),
});

export const query = async <T = any>(text: string, params?: any[]): Promise<T[]> => {
  const res = await pool.query(text, params);
  return res.rows as T[];
};

export const one = async <T = any>(text: string, params?: any[]): Promise<T | null> => {
  const res = await pool.query(text, params);
  return (res.rows?.[0] as T) ?? null;
};

// 在受控事务内执行查询，并注入 RLS / pgcrypto 会话变量。
// 会话变量用 set_config(..., true)（事务级本地），不会泄漏到连接池的其它请求。
// allowedTags 为空且非超级用户时回落 'public'，与应用层 accessFilterSql 语义一致。
// RLS 策略关闭时这些变量不会被任何策略读取；app.content_key 仅在配置了
// CONTENT_ENCRYPTION_KEY 时注入，供 app_pgp_decrypt() 解密 content_pgp 使用。
export const queryWithAccess = async <T = any>(
  text: string,
  params: any[] = [],
  allowedTags: string[] = [],
  isSuperuser = false,
): Promise<T[]> => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const tags = isSuperuser ? '' : (allowedTags.length ? allowedTags : ['public']).join(',');
    const sets: string[] = [];
    const setParams: unknown[] = [];
    sets.push(`set_config('app.current_tags', $${setParams.length + 1}, true)`);
    setParams.push(tags);
    sets.push(`set_config('app.is_superuser', $${setParams.length + 1}, true)`);
    setParams.push(isSuperuser ? 'on' : 'off');
    const contentKey = config.CONTENT_ENCRYPTION_KEY?.trim() ?? '';
    if (contentKey) {
      sets.push(`set_config('app.content_key', $${setParams.length + 1}, true)`);
      setParams.push(contentKey);
    }
    await client.query(`SELECT ${sets.join(', ')}`, setParams);
    const res = await client.query(text, params);
    await client.query('COMMIT');
    return res.rows as T[];
  } catch (e) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw e;
  } finally {
    client.release();
  }
};

// 管理员/运维上下文：以超级用户身份执行，绕过 chunks 表的 RLS SELECT 策略。
export const queryAsAdmin = <T = any>(text: string, params: any[] = []): Promise<T[]> =>
  queryWithAccess<T>(text, params, [], true);

export const vectorJson = (vec: number[]): string =>
  `[${vec.map(v => parseFloat(v.toFixed(6))).join(',')}]`;

export const closeConnections = async (): Promise<void> => {
  await pool.end();
  redis.disconnect();
};

// Vector helpers
export const VECTOR_DIMS = 1024; // BGE-M3
