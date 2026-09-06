// src/config.ts
import { z } from 'zod';
import dotenv from 'dotenv';

dotenv.config();

// 环境变量只有字符串，直接 z.coerce.boolean() 会把 "false" 判为 true，这里显式解析。
const boolFromEnv = (defaultValue: boolean) =>
  z
    .string()
    .default(String(defaultValue))
    .transform(v => v === 'true' || v === '1' || v === 'yes');

const ConfigSchema = z.object({
  DB_HOST: z.string().default('localhost'),
  DB_PORT: z.coerce.number().default(5432),
  DB_NAME: z.string().default('ragdb'),
  DB_USER: z.string().default('rag'),
  DB_PASSWORD: z.string().default('ragpass'),
  REDIS_HOST: z.string().default('localhost'),
  REDIS_PORT: z.coerce.number().default(6379),
  EMBEDDING_ENDPOINT_URL: z.string().url().default('http://localhost:8001/embeddings'),
  RERANK_ENDPOINT_URL: z.string().url().default('http://localhost:8001/rerank'),
  LLM_BASE_URL: z.string().default('http://localhost:8000/v1'),
  LLM_MODEL_NAME: z.string().default('Qwen/Qwen1.5-7B-Chat'),
  LLM_API_KEY: z.string().default(''),
  CHUNK_SIZE: z.coerce.number().default(300),
  CHUNK_OVERLAP: z.coerce.number().default(30),
  TOP_K_RETRIEVAL: z.coerce.number().default(50),
  TOP_K_RERANK: z.coerce.number().default(10),
  RERANK_THRESHOLD: z.coerce.number().default(0.1),
  PORT: z.coerce.number().default(9000),
  NODE_ENV: z.enum(['development', 'production']).default('development'),

  // 入库时是否做 PII 脱敏。默认关闭：脱敏会让库内内容与原文不一致，
  // 检索命中后展示给用户的将是被改写过的文本。
  SCRUB_PII: boolFromEnv(false),

  // 鉴权。API_KEY 为空时 /api/v1/* 开放（仅开发用，生产启动会告警）；
  // /api/v1/admin/* 强制要求 ADMIN_API_KEY，未配置即拒绝（fail-closed）。
  API_KEY: z.string().default(''),
  ADMIN_API_KEY: z.string().default(''),

  // CORS。逗号分隔的白名单；'*' 表示反射任意来源（此时会关闭 credentials）。
  CORS_ORIGIN: z.string().default('*'),

  RATE_LIMIT_ENABLED: boolFromEnv(true),
  RATE_LIMIT_MAX: z.coerce.number().default(60),
  RATE_LIMIT_WINDOW_SEC: z.coerce.number().default(60),

  AUDIT_ENABLED: boolFromEnv(true),
  CHAT_HISTORY_ENABLED: boolFromEnv(true),
});

export const config = ConfigSchema.parse(process.env);

export const dbUrl = `postgresql://${config.DB_USER}:${config.DB_PASSWORD}@${config.DB_HOST}:${config.DB_PORT}/${config.DB_NAME}`;
