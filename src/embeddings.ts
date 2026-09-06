// src/embeddings.ts
import axios from 'axios';
import { config } from './config';
import { VECTOR_DIMS } from './db';

export interface EmbeddingBatch {
  texts: string[];
  model?: string;
}

export interface EmbeddingResponse {
  embeddings: number[][];
}

export interface RerankBatch {
  query: string;
  passages: string[];
  top_k?: number;
}

export interface RerankResponse {
  results: Array<{ index: number; score: number }>;
}

export async function embedTexts(texts: string[], batchSize: number = 64): Promise<number[][]> {
  const embeddings: number[][] = [];

  for (let i = 0; i < texts.length; i += batchSize) {
    const batch = texts.slice(i, i + batchSize);

    try {
      const res = await axios.post<EmbeddingResponse>(config.EMBEDDING_ENDPOINT_URL, {
        texts: batch,
        model: 'BAAI/bge-m3',
      }, {
        headers: { 'Content-Type': 'application/json' },
        timeout: 60000,
      });

      embeddings.push(...res.data.embeddings);
    } catch (err) {
      const error = err as Error;
      console.error('Embedding failed:', error.message);
      throw new Error(`Failed to embed text batch: ${error.message}`);
    }
  }

  return embeddings;
}

export async function rerank(
  query: string,
  passages: string[],
  topK?: number,
): Promise<Array<{ originalIndex: number; score: number }>> {
  if (!passages.length) return [];

  const res = await axios.post<RerankResponse>(config.RERANK_ENDPOINT_URL, {
    query,
    passages,
    top_k: topK ?? config.TOP_K_RERANK,
  }, {
    headers: { 'Content-Type': 'application/json' },
    timeout: 60000,
  });

  return res.data.results.map(r => ({
    originalIndex: r.index,
    score: r.score,
  }));
}

export function normalizeEmbedding(vec: number[]): number[] {
  const norm = Math.sqrt(vec.reduce((sum, v) => sum + v * v, 0));
  if (norm === 0) return vec;
  return vec.map(v => v / norm);
}

export function truncateEmbedding(vec: number[], dims: number = VECTOR_DIMS): number[] {
  if (vec.length <= dims) return vec;
  return vec.slice(0, dims);
}
