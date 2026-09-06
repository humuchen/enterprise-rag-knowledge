// src/middleware/audit.ts
import { FastifyRequest } from 'fastify';
import { pool } from '../db';

// Audit logging middleware
export async function auditLogger(
  request: FastifyRequest,
  startTime: number,
  retrievedIds: string[] = [],
): Promise<void> {
  const latency = Date.now() - startTime;

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

// Rate limiting placeholder
export function rateLimit(userId: string): boolean {
  // Implement Redis-based sliding window rate limiting
  return true;
}
