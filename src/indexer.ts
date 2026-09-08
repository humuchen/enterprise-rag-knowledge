// src/indexer.ts
// 文档入库的唯一入口，供 CLI (src/ingest.ts) 与上传接口 (src/index.ts) 共用。
//
// 设计要点：
// 1. 向量化放在事务之外 —— embedding 是慢远程调用，放进事务会长时间持锁。
// 2. 写库走单事务 + 批量 INSERT —— 中途失败不会留下无 chunk 的孤儿文档。
// 3. 去重键是 (doc_id, hash) 而非全局 hash —— 不同文档的相同段落各自保留。
// 4. 返回真实落库行数 —— 早先版本返回 chunk 总数，被 ON CONFLICT 丢弃后计数虚高。

import { pool, VECTOR_DIMS } from './db';
import { embedTexts } from './embeddings';
import { buildSearchText } from './tokenize';
import type { ChunkDict } from './chunker';

const INSERT_BATCH = 100;

export interface IndexParams {
  source: string;
  title: string;
  language?: string;
  metadata?: Record<string, any>;
  chunks: ChunkDict[];
  accessTags: string[];
}

export interface IndexResult {
  docId: string;
  chunksInserted: number;
  chunksTotal: number;
}

function toVectorLiteral(emb: number[]): string {
  return '[' + emb.slice(0, VECTOR_DIMS).map(v => parseFloat(v.toFixed(6))).join(',') + ']';
}

export async function indexDocument(params: IndexParams): Promise<IndexResult> {
  const { source, title, language, metadata, chunks, accessTags } = params;

  if (!chunks.length) {
    throw new Error('No chunks produced after splitting');
  }

  const embeddings = await embedTexts(chunks.map(c => c.content));
  if (embeddings.length !== chunks.length) {
    throw new Error(
      `Embedding count mismatch: got ${embeddings.length}, expected ${chunks.length}`,
    );
  }

  const tags = accessTags.length ? accessTags : ['public'];
  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    const docRes = await client.query<{ id: string }>(
      `INSERT INTO documents (source, title, metadata, created_at)
       VALUES ($1, $2, $3, NOW())
       RETURNING id`,
      [source, title, JSON.stringify({ language: language ?? 'unknown', ...(metadata ?? {}) })],
    );

    const docId = docRes.rows[0].id;
    let inserted = 0;

    for (let offset = 0; offset < chunks.length; offset += INSERT_BATCH) {
      const slice = chunks.slice(offset, offset + INSERT_BATCH);
      const placeholders: string[] = [];
      const values: unknown[] = [];

      slice.forEach((chunk, j) => {
        const base = j * 8;
        placeholders.push(
          `($${base + 1}, $${base + 2}, $${base + 3}, $${base + 4}, $${base + 5}::vector, ` +
          `$${base + 6}, $${base + 7}, $${base + 8}, NOW(), NOW())`,
        );
        values.push(
          docId,
          chunk.content,
          chunk.searchText,
          chunk.hash,
          toVectorLiteral(embeddings[offset + j]),
          JSON.stringify(chunk.metadata ?? {}),
          tags,
          source,
        );
      });

      const res = await client.query(
        `INSERT INTO chunks
           (doc_id, content, search_text, hash, embedding, metadata, access_tags, source, created_at, updated_at)
         VALUES ${placeholders.join(', ')}
         ON CONFLICT (doc_id, hash) DO NOTHING`,
        values,
      );

      inserted += res.rowCount ?? 0;
    }

    if (inserted === 0) {
      await client.query('ROLLBACK');
      throw new Error('No new chunks inserted (content already indexed)');
    }

    await client.query('COMMIT');
    return { docId, chunksInserted: inserted, chunksTotal: chunks.length };
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}

// 为存量 chunk 回填 search_text（升级到 1.1.0 后，中文检索依赖该列）。
export async function backfillSearchText(): Promise<number> {
  const { rows } = await pool.query<{ id: string; content: string }>(
    'SELECT id, content FROM chunks WHERE search_text IS NULL',
  );

  let processed = 0;
  for (let i = 0; i < rows.length; i += INSERT_BATCH) {
    const slice = rows.slice(i, i + INSERT_BATCH);
    const placeholders: string[] = [];
    const values: unknown[] = [];

    slice.forEach((row, j) => {
      placeholders.push(`($${j * 2 + 1}::uuid, $${j * 2 + 2})`);
      values.push(row.id, buildSearchText(row.content));
    });

    await pool.query(
      `UPDATE chunks AS c
         SET search_text = v.search_text, updated_at = NOW()
       FROM (VALUES ${placeholders.join(', ')}) AS v(id, search_text)
       WHERE c.id = v.id`,
      values,
    );

    processed += slice.length;
    console.log(`Backfilled ${processed}/${rows.length}`);
  }

  return processed;
}

// 重算全库向量（换嵌入模型后使用）。同样按批更新，避免逐条往返。
export async function reindexAllEmbeddings(): Promise<number> {
  const { rows } = await pool.query<{ id: string; content: string }>(
    'SELECT id, content FROM chunks WHERE content IS NOT NULL ORDER BY created_at',
  );

  let processed = 0;
  for (let i = 0; i < rows.length; i += INSERT_BATCH) {
    const slice = rows.slice(i, i + INSERT_BATCH);
    const embeddings = await embedTexts(slice.map(r => r.content));

    const placeholders: string[] = [];
    const values: unknown[] = [];
    slice.forEach((row, j) => {
      placeholders.push(`($${j * 2 + 1}::uuid, $${j * 2 + 2}::vector)`);
      values.push(row.id, toVectorLiteral(embeddings[j]));
    });

    await pool.query(
      `UPDATE chunks AS c
         SET embedding = v.embedding, updated_at = NOW()
       FROM (VALUES ${placeholders.join(', ')}) AS v(id, embedding)
       WHERE c.id = v.id`,
      values,
    );

    processed += slice.length;
    console.log(`Reindexed ${processed}/${rows.length}`);
  }

  // 向量索引必须在重算后重建：ivfflat 是离库快照，批量更新 embedding 后若不 REINDEX，
  // ORDER BY embedding <=> query LIMIT 走索引会返回空/错结果（典型“重算后检索全失效”陷阱）。
  console.log('Rebuilding vector index chunks_embedding_idx ...');
  try {
    await pool.query('REINDEX INDEX CONCURRENTLY chunks_embedding_idx');
    console.log('Vector index rebuilt');
  } catch (err) {
    // CONCURRENTLY 失败（如仍在事务中）则退化为普通 REINDEX
    await pool.query('REINDEX INDEX chunks_embedding_idx');
    console.log('Vector index rebuilt (fallback)');
  }

  return processed;
}
