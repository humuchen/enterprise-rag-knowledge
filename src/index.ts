// src/index.ts
import Fastify from 'fastify';
import cors from '@fastify/cors';
import multipart from '@fastify/multipart';
import { config } from './config';
import { pool, redis, closeConnections } from './db';
import { HybridRetriever, QueryContext } from './retriever';
import { LLMClient } from './generator';
import { chunkDocument } from './chunker';
import { parseDocument } from './parsers';
import { indexDocument } from './indexer';
import { auditLogger, recordChatTurn } from './middleware/audit';
import { checkRateLimit, rateLimitIdentity } from './ratelimit';
import { writeFile, unlink } from 'fs/promises';
import { join, extname } from 'path';
import { tmpdir } from 'os';
import { randomUUID } from 'crypto';

declare module 'fastify' {
  interface FastifyRequest {
    retrievedIds?: string[];
  }
}

interface ChatRequestBody {
  query: string;
  session_id?: string;
  user_tags?: string[];
  history?: Array<{ role: string; content: string }>;
}

interface DocumentUploadResponse {
  document_id: string;
  chunks_created: number;
  chunks_total: number;
  title: string;
  latency_ms: number;
}

const fastify = Fastify({ logger: true });

const retriever = new HybridRetriever();
const llmClient = new LLMClient();

const SUPPORTED_EXTS = ['.pdf', '.docx', '.doc', '.txt', '.md', '.html', '.htm'];
const ADMIN_PREFIX = '/api/v1/admin';

function parseCorsOrigins(): true | string[] {
  const raw = config.CORS_ORIGIN.trim();
  if (!raw || raw === '*') return true;
  return raw.split(',').map(s => s.trim()).filter(Boolean);
}

// Register plugins
const corsOrigins = parseCorsOrigins();
fastify.register(cors, {
  origin: corsOrigins,
  // 反射任意来源时不能同时放行凭证，否则等于向全网开放身份。
  credentials: corsOrigins !== true,
});

fastify.register(multipart, {
  limits: {
    fileSize: 100 * 1024 * 1024,
  },
});

// 鉴权 + 限流
fastify.addHook('onRequest', async (request, reply) => {
  const path = (request.raw.url ?? '').split('?')[0];
  if (path === '/health') return;

  if (path.startsWith(ADMIN_PREFIX)) {
    if (!config.ADMIN_API_KEY) {
      return reply
        .status(503)
        .send({ error: 'Admin endpoints disabled: ADMIN_API_KEY is not configured' });
    }
    if (request.headers['x-api-key'] !== config.ADMIN_API_KEY) {
      return reply.status(401).send({ error: 'Unauthorized' });
    }
    return;
  }

  if (!path.startsWith('/api/v1')) return;

  if (config.API_KEY && request.headers['x-api-key'] !== config.API_KEY) {
    return reply.status(401).send({ error: 'Unauthorized' });
  }

  if (!config.RATE_LIMIT_ENABLED) return;

  const verdict = await checkRateLimit(
    rateLimitIdentity(request),
    config.RATE_LIMIT_MAX,
    config.RATE_LIMIT_WINDOW_SEC,
  );

  if (!verdict.allowed) {
    reply.header('Retry-After', String(verdict.retryAfterSec));
    return reply.status(429).send({ error: 'Rate limit exceeded' });
  }

  reply.header('X-RateLimit-Remaining', String(verdict.remaining));
});

// 审计落库
fastify.addHook('onResponse', async (request, reply) => {
  await auditLogger(request, reply.getResponseTime(), request.retrievedIds ?? []);
});

async function probeDb(): Promise<boolean> {
  try {
    await pool.query('SELECT 1');
    return true;
  } catch {
    return false;
  }
}

async function probeRedis(): Promise<boolean> {
  try {
    await redis.ping();
    return true;
  } catch {
    return false;
  }
}

// Health check —— 真实探测各依赖，不再返回硬编码的 connected
fastify.get('/health', async (_request, reply) => {
  const [dbOk, redisOk, llmOk] = await Promise.all([
    probeDb(),
    probeRedis(),
    llmClient.healthCheck(),
  ]);

  const status = dbOk && llmOk ? 'healthy' : 'degraded';

  return reply.status(status === 'healthy' ? 200 : 503).send({
    status,
    vector_db: dbOk ? 'connected' : 'unavailable',
    redis: redisOk ? 'connected' : 'unavailable',
    llm_endpoint: llmOk ? 'ok' : 'unavailable',
    version: '1.1.0',
  });
});

// Non-streaming chat
fastify.post('/api/v1/chat', async (request, reply) => {
  const start = Date.now();
  const body = request.body as ChatRequestBody;

  if (!body.query?.trim()) {
    return reply.status(400).send({ error: 'Query is empty' });
  }

  const sessionId = body.session_id || randomUUID();
  const ctx: QueryContext = {
    userTags: body.user_tags ?? [],
    sessionId,
    history: body.history ?? [],
    language: 'auto',
  };

  const results = await retriever.retrieve(body.query, ctx);
  request.retrievedIds = results.map(r => r.chunkId);

  if (!results.length) {
    return reply.send({
      answer: '抱歉，我在知识库中没有找到相关信息。',
      citations: [],
      model: config.LLM_MODEL_NAME,
    });
  }

  const genResult = await llmClient.generate(
    body.query,
    results,
    body.history ?? [],
  );

  await recordChatTurn({
    sessionId,
    query: body.query,
    answer: genResult.answer,
    sources: results.map(r => ({ chunkId: r.chunkId, source: r.source, score: r.score })),
  });

  return reply.send({
    answer: genResult.answer,
    citations: genResult.citations.map(c => ({
      chunk_id: c.chunkId,
      source: c.source,
      content: c.content,
      score: c.score,
    })),
    model: genResult.model,
    latency_ms: Date.now() - start,
  });
});

// Streaming chat
fastify.post('/api/v1/chat/stream', async (request, reply) => {
  const start = Date.now();
  const body = request.body as ChatRequestBody;

  if (!body.query?.trim()) {
    return reply.status(400).send({ error: 'Query is empty' });
  }

  const sessionId = body.session_id || randomUUID();
  const ctx: QueryContext = {
    userTags: body.user_tags ?? [],
    sessionId,
    history: body.history ?? [],
    language: 'auto',
  };

  const results = await retriever.retrieve(body.query, ctx);
  request.retrievedIds = results.map(r => r.chunkId);

  reply.type('text/event-stream');
  reply.header('Cache-Control', 'no-cache');

  // 客户端断开时终止生成，避免上游 LLM 流继续消耗资源
  let aborted = false;
  request.raw.on('close', () => {
    aborted = true;
  });

  if (!results.length) {
    return reply.send(
      `data: ${JSON.stringify({ type: 'done', answer: '抱歉，我在知识库中没有找到相关信息。', citations: [], latency_ms: Date.now() - start })}\n\n`,
    );
  }

  const eventStream = (async function* () {
    yield `data: ${JSON.stringify({ type: 'metadata', session_id: sessionId, chunks_retrieved: results.length })}\n\n`;

    let answer = '';
    for await (const token of llmClient.stream(
      body.query,
      results,
      body.history ?? [],
      0.1,
      2048,
      () => aborted,
    )) {
      if (aborted) return;
      answer += token;
      yield `data: ${JSON.stringify({ type: 'token', content: token })}\n\n`;
    }

    if (aborted) return;

    yield `data: ${JSON.stringify({ type: 'citations', items: results.map(r => ({
      chunk_id: r.chunkId,
      source: r.source,
      score: r.score,
      content: r.content.slice(0, 200),
    })) })}\n\n`;

    yield `data: ${JSON.stringify({ type: 'done', latency_ms: Date.now() - start })}\n\n`;

    await recordChatTurn({
      sessionId,
      query: body.query,
      answer,
      sources: results.map(r => ({ chunkId: r.chunkId, source: r.source, score: r.score })),
    });
  })();

  for await (const chunk of eventStream) {
    if (aborted || reply.raw.destroyed) break;
    reply.raw.write(chunk);
  }

  if (!reply.raw.writableEnded) {
    reply.raw.end();
  }
});

// Document upload
fastify.post('/api/v1/documents', async (request, reply) => {
  const start = Date.now();

  const parts = (request as any).parts() as AsyncIterable<{
    type: string;
    fieldname: string;
    filename?: string;
    value?: any;
    toBuffer: () => Promise<Buffer>;
  }>;

  let fileBuffer: Buffer | null = null;
  let fileName = '';
  let title: string | undefined;
  let accessTags: string[] | undefined;

  for await (const part of parts) {
    if (part.type === 'file') {
      fileBuffer = await part.toBuffer();
      fileName = part.filename ?? '';
    } else {
      const value = await part.value;
      if (part.fieldname === 'title') title = value as string;
      if (part.fieldname === 'access_tags') {
        try {
          accessTags = JSON.parse(value as string);
        } catch {
          accessTags = String(value).split(',');
        }
      }
    }
  }

  if (!fileBuffer || !fileName) {
    return reply.status(400).send({ error: 'No file provided' });
  }

  const ext = extname(fileName);
  if (!SUPPORTED_EXTS.includes(ext.toLowerCase())) {
    return reply.status(400).send({ error: `Unsupported file type: ${ext}` });
  }

  const tmpPath = join(tmpdir(), `rag-${randomUUID()}${ext}`);
  await writeFile(tmpPath, fileBuffer);

  try {
    const { text, lang } = await parseDocument(tmpPath, config.SCRUB_PII);
    if (text.length < 10) {
      throw new Error('Document too short after parsing');
    }

    const chunks = chunkDocument(
      text,
      fileName,
      title ?? fileName,
      { language: lang, original_filename: fileName },
    );

    const result = await indexDocument({
      source: fileName,
      title: title ?? fileName,
      language: lang,
      metadata: { original_filename: fileName },
      chunks,
      accessTags: accessTags ?? ['public'],
    });

    return reply.status(201).send({
      document_id: result.docId,
      chunks_created: result.chunksInserted,
      chunks_total: result.chunksTotal,
      title: title ?? fileName,
      latency_ms: Date.now() - start,
    } as DocumentUploadResponse);
  } catch (err) {
    const error = err as Error;
    console.error('Document upload failed:', error.message);
    return reply.status(500).send({
      error: 'Indexing failed',
      detail: error.message,
    });
  } finally {
    await unlink(tmpPath).catch(() => undefined);
  }
});

// Get document
fastify.get('/api/v1/documents/:doc_id', async (request, reply) => {
  const { doc_id } = request.params as { doc_id: string };

  const doc = await pool.query<{
    id: string;
    source: string;
    title: string | null;
    metadata: Record<string, any>;
    created_at: Date;
  }>(
    `SELECT id, source, title, metadata, created_at FROM documents WHERE id = $1`,
    [doc_id],
  );

  if (!doc.rows[0]) {
    return reply.status(404).send({ error: 'Document not found' });
  }

  const chunkCount = await pool.query<{ count: string }>(
    `SELECT COUNT(*) FROM chunks WHERE doc_id = $1`,
    [doc_id],
  );

  return {
    id: doc.rows[0].id,
    source: doc.rows[0].source,
    title: doc.rows[0].title,
    metadata: doc.rows[0].metadata,
    chunk_count: parseInt(chunkCount.rows[0].count),
    created_at: doc.rows[0].created_at,
  };
});

// Delete document
fastify.delete('/api/v1/documents/:doc_id', async (request, reply) => {
  const { doc_id } = request.params as { doc_id: string };

  const result = await pool.query('DELETE FROM documents WHERE id = $1 RETURNING id', [doc_id]);

  if (result.rowCount === 0) {
    return reply.status(404).send({ error: 'Document not found' });
  }

  console.log(`Deleted document ${doc_id}`);
  return { status: 'deleted', document_id: doc_id };
});

// Admin metrics
fastify.get('/api/v1/admin/metrics', async () => {
  const chunkCount = await pool.query<{ count: string }>('SELECT COUNT(*) FROM chunks');
  const docCount = await pool.query<{ count: string }>('SELECT COUNT(*) FROM documents');

  return {
    documents_total: parseInt(docCount.rows[0].count),
    chunks_total: parseInt(chunkCount.rows[0].count),
    uptime: process.uptime(),
  };
});

// Global error handler
fastify.setErrorHandler((error, _request, reply) => {
  console.error('Unhandled error:', error.message);
  reply.status(500).send({
    error: 'Internal server error',
    detail: error.message,
  });
});

// Startup
const start = async () => {
  if (config.NODE_ENV === 'production' && !config.API_KEY) {
    fastify.log.warn('API_KEY is not set: /api/v1/* is open to the network');
  }
  if (config.NODE_ENV === 'production' && !config.ADMIN_API_KEY) {
    fastify.log.warn('ADMIN_API_KEY is not set: /api/v1/admin/* is disabled');
  }

  try {
    await fastify.listen({ port: config.PORT, host: '0.0.0.0' });
    fastify.log.info(`RAG API running on http://0.0.0.0:${config.PORT}`);
  } catch (err) {
    fastify.log.error(err);
    await closeConnections();
    process.exit(1);
  }
};

const shutdown = async () => {
  await fastify.close();
  await closeConnections();
  process.exit(0);
};

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

start();
