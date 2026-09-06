// src/config.ts
import { z } from 'zod';
import dotenv from 'dotenv';

dotenv.config();

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
  CHUNK_SIZE: z.coerce.number().default(300),
  CHUNK_OVERLAP: z.coerce.number().default(30),
  TOP_K_RETRIEVAL: z.coerce.number().default(50),
  TOP_K_RERANK: z.coerce.number().default(10),
  RERANK_THRESHOLD: z.coerce.number().default(0.1),
  PORT: z.coerce.number().default(9000),
  NODE_ENV: z.enum(['development', 'production']).default('development'),
});

export const config = ConfigSchema.parse(process.env);

export const dbUrl = `postgresql://${config.DB_USER}:${config.DB_PASSWORD}@${config.DB_HOST}:${config.DB_PORT}/${config.DB_NAME}`;
