// src/redact.ts
// 呈现层遮盖（方案 B）：在检索结果返回前，对无权限用户将敏感 span 替换为占位符。
// 不改变落库内容，不影响向量；仅作用于送往 LLM / 前端的文本。

export interface SensitiveSpan {
  start: number; // 相对 chunk.content 的起始偏移
  end: number; // 结束偏移（不含）
  level: string; // 敏感级别/类型，如 'pii' / 'ssn'
  requiredTags: string[]; // 需持有的 access_tags 才能查看原文，如 ['exec']
}

const MASK = '[已脱敏]';

export function redactContent(
  content: string,
  spans: SensitiveSpan[] | undefined,
  userTags: string[],
  isSuperuser: boolean,
): string {
  if (isSuperuser) return content;
  if (!spans || spans.length === 0) return content;

  const canView = (s: SensitiveSpan) => s.requiredTags.some((t) => userTags.includes(t));

  // 从后往前替换，避免偏移错位
  const sorted = [...spans].sort((a, b) => b.start - a.start);
  let out = content;
  for (const s of sorted) {
    if (s.start < 0 || s.end > out.length || s.start >= s.end) continue;
    if (!canView(s)) {
      out = out.slice(0, s.start) + MASK + out.slice(s.end);
    }
  }
  return out;
}
