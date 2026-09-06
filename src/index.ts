// src/index.ts
import Fastify from 'fastify';
import { config } from './config';
import { pool, closeConnections, VECTOR_DIMS } from './db';
import { HybridRetriever, QueryContext } from './retriever';
import { LLMClient } from './generator';
import { chunkDocument } from './chunker';
import { parseDocument } from './parsers';
import { embedTexts } from './embeddings';
import { writeFile, unlink } from 'fs/promises';
import { join, extname } from 'path';
import { tmpdir } from 'os';
import { randomUUID } from 'crypto';

interface ChatRequestBody {
  query: string;
  session_id?: string;
  user_tags?: string[];
  history?: Array<{ role: string; content: string }>;
}

interface DocumentUploadResponse {
  document_id: string;
  chunks_created: number;
  title: string;
  latency_ms: number;
}

const fastify = Fastify({ logger: true });

const retriever = new HybridRetriever();
const llmClient = new LLMClient();

// Register plugins
fastify.register(require('@fastify/cors'), {
  origin: true,
  credentials: true,
});

fastify.register(require('@fastify/multipart'), {
  limits: {
    fileSize: 100 * 1024 * 1024,
  },
});

// Health check
fastify.get('/health', async () => {
  const llmOk = await llmClient.healthCheck();
  return {
    status: llmOk ? 'healthy' : 'degraded',
    vector_db: 'connected',
    llm_endpoint: llmOk ? 'ok' : 'unavailable',
    version: '1.0.0',
  };
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

  return reply.send({
    answer: genResult.answer,
    citations: genResult.citations.map(c => ({
      chunk_id: c.chunkId,
      source: c.source,
      content: c.content,
      score: c.score,
    })),
    model: genResult.model,
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

  if (!results.length) {
    reply.type('text/event-stream');
    reply.header('Cache-Control', 'no-cache');
    return reply.send(
      `data: ${JSON.stringify({ type: 'done', answer: '抱歉，我在知识库中没有找到相关信息。', citations: [], latency_ms: Date.now() - start })}\n\n`,
    );
  }

  reply.type('text/event-stream');
  reply.header('Cache-Control', 'no-cache');

  const eventStream = (async function* () {
    yield `data: ${JSON.stringify({ type: 'metadata', session_id: sessionId, chunks_retrieved: results.length })}\n\n`;

    for await (const token of llmClient.stream(body.query, results, body.history ?? [])) {
      yield `data: ${JSON.stringify({ type: 'token', content: token })}\n\n`;
    }

    yield `data: ${JSON.stringify({ type: 'citations', items: results.map(r => ({
      chunk_id: r.chunkId,
      source: r.source,
      score: r.score,
      content: r.content.slice(0, 200),
    })) })}\n\n`;

    yield `data: ${JSON.stringify({ type: 'done', latency_ms: Date.now() - start })}\n\n`;
  })();

  for await (const chunk of eventStream) {
    reply.raw.write(chunk);
  }
  reply.raw.end();
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
  const supported = ['.pdf', '.docx', '.doc', '.txt', '.md', '.html', '.htm'];
  if (!supported.includes(ext.toLowerCase())) {
    return reply.status(400).send({ error: `Unsupported file type: ${ext}` });
  }

  const tmpPath = join(tmpdir(), `rag-${randomUUID()}${ext}`);
  await writeFile(tmpPath, fileBuffer);

  try {
    const { text, lang } = await parseDocument(tmpPath, true);
    if (text.length < 10) {
      throw new Error('Document too short after parsing');
    }

    const chunks = chunkDocument(
      text,
      fileName,
      title ?? fileName,
      { language: lang, original_filename: fileName },
    );

    if (!chunks.length) {
      throw new Error('No chunks produced after splitting');
    }

    const texts = chunks.map(c => c.content);
    const embeddings = await embedTexts(texts);

    const res = await pool.query<{ id: string }>(
      `INSERT INTO documents (source, title, metadata, created_at)
       VALUES ($1, $2, $3, NOW())
       RETURNING id`,
      [fileName, title ?? fileName, JSON.stringify({ language: lang })],
    );

    const docId = res.rows[0].id;

    for (let i = 0; i < chunks.length; i++) {
      const emb = embeddings[i];
      const vecStr = '[' + emb.slice(0, VECTOR_DIMS).map((v: number) => parseFloat(v.toFixed(6))).join(',') + ']';

      await pool.query(
        `INSERT INTO chunks (doc_id, content, hash, metadata, embedding, access_tags, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5::vector, $6, NOW(), NOW())
         ON CONFLICT (hash) DO NOTHING`,
        [docId, chunks[i].content, chunks[i].hash, JSON.stringify(chunks[i].metadata), vecStr, accessTags ?? ['public']],
      );
    }

    return reply.status(201).send({
      document_id: docId,
      chunks_created: chunks.length,
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
    await unlink(tmpPath);
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
