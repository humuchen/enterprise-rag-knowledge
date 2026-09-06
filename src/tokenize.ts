// src/tokenize.ts
// PostgreSQL 自带的 default text search parser 无法切分 CJK：连续汉字会被当成
// 一个 token，导致中文语料下 FTS 分支几乎零召回。这里在应用层把连续 CJK 串
// 展开为 bigram，再交给 to_tsvector('simple', ...) 索引，使中文可被检索。
// 入库与查询两侧必须使用同一个函数，否则 token 无法对齐。

const CJK_PATTERN = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\u3040-\u309f\u30a0-\u30ff]/;
const DELIMITER_PATTERN = /[\s\p{P}\p{S}\p{C}]/u;

export function isCjk(ch: string): boolean {
  return CJK_PATTERN.test(ch);
}

export function cjkBigram(segment: string): string[] {
  if (!segment) return [];
  if (segment.length === 1) return [segment];
  const grams: string[] = [];
  for (let i = 0; i < segment.length - 1; i++) {
    grams.push(segment.slice(i, i + 2));
  }
  return grams;
}

export function buildSearchText(text: string): string {
  const src = (text ?? '').toLowerCase();
  const tokens: string[] = [];
  let latin = '';
  let cjk = '';

  const flushLatin = (): void => {
    const trimmed = latin.trim();
    if (trimmed) tokens.push(trimmed);
    latin = '';
  };

  const flushCjk = (): void => {
    if (cjk) {
      tokens.push(...cjkBigram(cjk));
      cjk = '';
    }
  };

  for (const ch of src) {
    if (isCjk(ch)) {
      flushLatin();
      cjk += ch;
    } else if (DELIMITER_PATTERN.test(ch)) {
      flushLatin();
      flushCjk();
    } else {
      flushCjk();
      latin += ch;
    }
  }

  flushLatin();
  flushCjk();

  return tokens.join(' ');
}
