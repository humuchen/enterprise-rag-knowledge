// src/ratelimit.ts
// 基于 Redis 有序集合的滑动窗口限流。
// Redis 不可用时放行（fail-open）：限流是保护层，不应成为可用性瓶颈。

import { redis } from './db';

export interface RateLimitVerdict {
  allowed: boolean;
  remaining: number;
  retryAfterSec: number;
}

export async function checkRateLimit(
  identifier: string,
  limit: number,
  windowSec: number,
): Promise<RateLimitVerdict> {
  if (limit <= 0) {
    return { allowed: true, remaining: Number.MAX_SAFE_INTEGER, retryAfterSec: 0 };
  }

  const key = `rl:${identifier}`;
  const now = Date.now();
  const windowStart = now - windowSec * 1000;
  const member = `${now}-${Math.random().toString(36).slice(2)}`;

  try {
    const pipeline = redis.multi();
    pipeline.zremrangebyscore(key, 0, windowStart);
    pipeline.zadd(key, now, member);
    pipeline.zcard(key);
    pipeline.pexpire(key, windowSec * 1000);

    const results = await pipeline.exec();
    const count = Number(results?.[2]?.[1] ?? 0);

    if (count > limit) {
      await redis.zrem(key, member);
      return { allowed: false, remaining: 0, retryAfterSec: windowSec };
    }

    return { allowed: true, remaining: Math.max(limit - count, 0), retryAfterSec: 0 };
  } catch (err) {
    console.error('Rate limit check failed, allowing request:', (err as Error).message);
    return { allowed: true, remaining: limit, retryAfterSec: 0 };
  }
}

// 优先按 API Key 限流，其次按来源 IP。
export function rateLimitIdentity(request: {
  headers: Record<string, unknown>;
  ip: string;
}): string {
  const key = request.headers['x-api-key'];
  if (typeof key === 'string' && key) return `key:${key}`;
  return `ip:${request.ip}`;
}
