// src/retriever.ts
import { query, vectorJson } from './db';
import { config } from './config';
import { embedTexts, rerank } from './embeddings';
import { buildSearchText } from './tokenize';

export interface QueryContext {
  userTags: string[];
  sessionId: string;
  history: Array<{ role: string; content: string }>;
  language: 'auto' | 'zh' | 'en';
}

export interface SearchResult {
  chunkId: string;
  content: string;
  source: string;
  score: number;
  metadata: Record<string, any>;
  accessTags: string[];
  docTitle: string;
  createdAt: Date;
}

// Row types
interface DenseRow {
  id: string;
  doc_id: string;
  content: string;
  metadata: Record<string, any>;
  access_tags: string[];
  similarity: number;
  source: string;
  title: string;
  created_at: Date;
}

interface SparseRow {
  id: string;
  doc_id: string;
  content: string;
  metadata: Record<string, any>;
  access_tags: string[];
  rank: number;
  source: string;
  title: string;
  created_at: Date;
}

// Dense retrieval via pgvector
async function denseRetrieve(
  queryVector: number[],
  topK: number,
): Promise<DenseRow[]> {
  const vecStr = vectorJson(queryVector);

  const rows = await query<DenseRow>(
    `SELECT c.id, c.doc_id, c.content, c.metadata, c.access_tags,
            1 - (c.embedding <=> $1::vector) AS similarity,
            d.source, d.title, d.created_at
     FROM chunks c
     JOIN documents d ON c.doc_id = d.id
     WHERE c.embedding IS NOT NULL
     ORDER BY c.embedding <=> $1::vector
     LIMIT $2`,
    [vecStr, topK],
  );

  return rows;
}

// Sparse retrieval via PostgreSQL FTS (BM25 approximation)
// 查询侧必须与入库侧使用同一套 token 化规则（buildSearchText + simple 配置），
// 否则中文 token 无法对齐，稀疏分支召回为零。
async function sparseRetrieve(
  queryText: string,
  topK: number,
): Promise<SparseRow[]> {
  const expanded = buildSearchText(queryText).trim();
  if (!expanded) return [];

  const rows = await query<SparseRow>(
    `SELECT c.id, c.doc_id, c.content, c.metadata, c.access_tags,
            ts_rank_cd(fts.tsv, q.query) AS rank,
            d.source, d.title, d.created_at
     FROM chunks c
     JOIN documents d ON c.doc_id = d.id
     CROSS JOIN LATERAL to_tsvector('simple', coalesce(c.search_text, '')) AS fts(tsv)
     CROSS JOIN LATERAL plainto_tsquery('simple', $1) AS q(query)
     WHERE fts.tsv @@ q.query
     ORDER BY rank DESC
     LIMIT $2`,
    [expanded, topK],
  );

  return rows;
}

// RRF fusion
function reciprocalRankFusion(
  dense: DenseRow[],
  sparse: SparseRow[],
  k: number = 60,
): Array<{ item: DenseRow | SparseRow; fusedScore: number }> {
  const scores = new Map<string, number>();
  const map = new Map<string, DenseRow | SparseRow>();

  for (let i = 0; i < dense.length; i++) {
    const id = dense[i].id;
    scores.set(id, (scores.get(id) ?? 0) + 1 / (i + k));
    map.set(id, dense[i]);
  }

  for (let i = 0; i < sparse.length; i++) {
    const id = sparse[i].id;
    scores.set(id, (scores.get(id) ?? 0) + 1 / (i + k));
    if (!map.has(id)) map.set(id, sparse[i]);
  }

  const sorted = [...scores.entries()].sort((a, b) => b[1] - a[1]);

  return sorted.map(([id, score]) => ({
    item: map.get(id) as DenseRow | SparseRow,
    fusedScore: score,
  }));
}

// Access control
function applyAccessFilter(
  results: Array<{ item: DenseRow | SparseRow; fusedScore: number }>,
  userTags: string[],
): Array<{ item: DenseRow | SparseRow; fusedScore: number }> {
  if (!userTags.length) {
    return results.filter(r => (r.item.access_tags ?? []).includes('public'));
  }
  const tagSet = new Set(userTags);
  return results.filter(r =>
    (r.item.access_tags ?? []).some((t: string) => tagSet.has(t)),
  );
}

export class HybridRetriever {
  async retrieve(queryText: string, ctx: QueryContext): Promise<SearchResult[]> {
    const start = Date.now();
    const topK = config.TOP_K_RETRIEVAL;

    // 1. Embed the query
    const queryEmbedding = await embedTexts([queryText]);
    const queryVector = queryEmbedding[0];

    // 2. Parallel dense + sparse retrieval
    const [dense, sparse] = await Promise.all([
      denseRetrieve(queryVector, topK),
      sparseRetrieve(queryText, topK),
    ]);

    // 3. RRF fusion
    const fused = reciprocalRankFusion(dense, sparse);

    // 4. Access control
    const filtered = applyAccessFilter(fused, ctx.userTags);

    // 5. Rerank
    const topCandidates = filtered.slice(0, topK);

    if (!topCandidates.length) {
      return [];
    }

    const passages = topCandidates.map(r => r.item.content);
    const reranked = await rerank(queryText, passages, config.TOP_K_RERANK);

    // 6. Format results（丢弃低于阈值的重排结果，避免低分噪声进入上下文）
    const result: SearchResult[] = [];
    for (const { originalIndex, score } of reranked) {
      if (score < config.RERANK_THRESHOLD) continue;
      const candidate = topCandidates[originalIndex];
      if (!candidate) continue;
      const item = candidate.item;
      result.push({
        chunkId: item.id,
        content: item.content,
        source: item.source ?? 'unknown',
        score,
        metadata: item.metadata ?? {},
        accessTags: item.access_tags ?? [],
        docTitle: item.title ?? item.source,
        createdAt: item.created_at,
      });
    }

    const elapsed = Date.now() - start;
    console.log(`[Retriever] retrieved ${result.length} chunks in ${elapsed}ms`);

    return result;
  }

  async hybridSearch(
    query: string,
    ctx: QueryContext,
  ): Promise<SearchResult[]> {
    return this.retrieve(query, ctx);
  }
}
