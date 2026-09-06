// src/middleware/audit.ts
import type { FastifyRequest } from 'fastify';
import { pool } from '../db';
import { config } from '../config';

// Audit logging middleware
export async function auditLogger(
  request: FastifyRequest,
  latencyMs: number,
  retrievedIds: string[] = [],
): Promise<void> {
  if (!config.AUDIT_ENABLED) return;

  const latency = Math.max(Math.round(latencyMs), 0);

  try {
    await pool.query(
      `INSERT INTO audit_log (user_id, action, query, latency_ms, retrieved_ids)
       VALUES ($1, $2, $3, $4, $5)`,
      [
        (request.headers['x-user-id'] as string) ?? null,
        request.routerPath ?? 'unknown',
        (request.body as { query?: string })?.query ?? null,
        latency,
        retrievedIds,
      ],
    );
  } catch (err) {
    console.error('Audit log failed:', (err as Error).message);
  }
}

// 写入一轮问答。失败只告警不计入主流程错误。
export async function recordChatTurn(params: {
  sessionId: string;
  query: string;
  answer: string;
  sources: Array<{ chunkId: string; source: string; score: number }>;
}): Promise<void> {
  if (!config.CHAT_HISTORY_ENABLED) return;

  const { sessionId, query, answer, sources } = params;
  try {
    await pool.query(
      `INSERT INTO chat_history (session_id, role, content, sources, created_at)
       VALUES ($1, 'user', $2, NULL, NOW()), ($1, 'assistant', $3, $4, NOW())`,
      [sessionId, query, answer, JSON.stringify(sources ?? [])],
    );
  } catch (err) {
    console.error('Chat history write failed:', (err as Error).message);
  }
}
