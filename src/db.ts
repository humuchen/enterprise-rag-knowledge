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

export const vectorJson = (vec: number[]): string =>
  `[${vec.map(v => parseFloat(v.toFixed(6))).join(',')}]`;

export const closeConnections = async (): Promise<void> => {
  await pool.end();
  redis.disconnect();
};

// Vector helpers
export const VECTOR_DIMS = 1024; // BGE-M3
