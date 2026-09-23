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

  // 服务端主体绑定：API Key -> 可访问标签集（JSON 字符串）。
  // 取代客户端自报的 user_tags，使权限判断有可信身份锚点。
  // 例：{"k_employee":"public","k_hr":"public,hr","k_exec":"public,hr,exec,confidential"}
  PRINCIPAL_TAGS: z.string().default('{}').transform((s): Record<string, string[]> => {
    try {
      const parsed = JSON.parse(s);
      return typeof parsed === 'object' && parsed ? parsed : {};
    } catch {
      return {};
    }
  }),

  // 未登记 Key（仅匹配 API_KEY）时的默认标签集，逗号分隔。
  DEFAULT_USER_TAGS: z.string().default('public').transform((s) =>
    s.split(',').map((x) => x.trim()).filter(Boolean),
  ),

  // 主体可读标签（用于审计落库的人类可读身份，与 PRINCIPAL_TAGS 的 Key 对应）。
  // 例：{"k_employee":"员工","k_hr":"人事","k_exec":"高管"}
  PRINCIPAL_LABELS: z.string().default('{}').transform((s): Record<string, string> => {
    try {
      const parsed = JSON.parse(s);
      return typeof parsed === 'object' && parsed ? parsed : {};
    } catch {
      return {};
    }
  }),

  // 落库内容加密密钥（AES-256-GCM）。缺省为空 -> 不加密（明文落库，仅开发用）。
  // 生产务必配置 64 位 hex / 32 字节 base64 / 任意口令；密钥仅存服务端，绝不入库。
  // 仅含 sensitiveSpans 的敏感切片会加密 content、并将其 search_text 置空。
  CONTENT_ENCRYPTION_KEY: z.string().default(''),

  // CORS。逗号分隔的白名单；'*' 表示反射任意来源（此时会关闭 credentials）。
  CORS_ORIGIN: z.string().default('*'),

  RATE_LIMIT_ENABLED: boolFromEnv(true),
  RATE_LIMIT_MAX: z.coerce.number().default(60),
  RATE_LIMIT_WINDOW_SEC: z.coerce.number().default(60),

  AUDIT_ENABLED: boolFromEnv(true),
  CHAT_HISTORY_ENABLED: boolFromEnv(true),

  // 是否启用数据库层行级安全（RLS）。默认关闭；开启后 migrate 会在 chunks 表建立
  // FOR SELECT 策略，读取路径（retriever）会注入会话变量 app.current_tags /
  // app.is_superuser，形成与应用层 `access_tags && $tags` 过滤互补的 DB 层纵深防御。
  // RLS 为 fail-closed：未注入会话变量时所有读取被策略拒绝。
  DB_RLS_ENABLED: boolFromEnv(false),
});

export const config = ConfigSchema.parse(process.env);

export const dbUrl = `postgresql://${config.DB_USER}:${config.DB_PASSWORD}@${config.DB_HOST}:${config.DB_PORT}/${config.DB_NAME}`;
