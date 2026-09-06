// src/chunker.ts
import crypto from 'crypto';
import { buildSearchText } from './tokenize';

const SEPARATORS: Array<{ pattern: RegExp; label: string }> = [
  { pattern: /^#{1,6}\s/m, label: 'header' },
  { pattern: /\n\n+/, label: 'paragraph' },
  { pattern: /\n\s*\n/m, label: 'blank_line' },
  { pattern: /[。.！？!?\n]/, label: 'sentence' },
];

export class TextSplitter {
  constructor(
    private chunkSize: number = 300,
    private chunkOverlap: number = 30,
  ) {}

  split(text: string): string[] {
    const cleaned = this._preClean(text);
    return this._recursiveSplit(cleaned, SEPARATORS, 0);
  }

  private _recursiveSplit(text: string, separators: typeof SEPARATORS, depth: number): string[] {
    if (!text.trim()) return [];

    if (text.length <= this.chunkSize || depth >= separators.length) {
      return this._wordSplit(text);
    }

    const { pattern } = separators[depth];
    const parts = text.split(pattern).filter(p => p.trim());

    if (parts.length <= 1) {
      return this._recursiveSplit(text, separators, depth + 1);
    }

    const subChunks: string[] = [];
    for (const part of parts) {
      subChunks.push(...this._recursiveSplit(part, separators, depth + 1));
    }

    return this._mergeWithOverlap(subChunks);
  }

  private _mergeWithOverlap(chunks: string[]): string[] {
    const result: string[] = [];
    let buffer = '';

    for (const chunk of chunks) {
      if (buffer.length + chunk.length <= this.chunkSize) {
        buffer = (buffer ? buffer + ' ' + chunk : chunk).trim();
      } else {
        if (buffer) result.push(buffer);
        buffer = chunk;
      }
    }

    if (buffer) result.push(buffer);

    // Add overlap
    const final: string[] = [];
    for (let i = 0; i < result.length; i++) {
      if (i > 0 && result[i].length > this.chunkOverlap) {
        const prevTail = result[i - 1].slice(-this.chunkOverlap);
        final.push(`${prevTail}...\n${result[i]}`);
      } else {
        final.push(result[i]);
      }
    }

    return final;
  }

  private _wordSplit(text: string): string[] {
    const words = text.split(/\s+/);
    const out: string[] = [];
    let cur: string[] = [];
    let len = 0;

    for (const w of words) {
      if (len + w.length + 1 > this.chunkSize) {
        if (cur.length) out.push(cur.join(' '));
        cur = [w];
        len = w.length;
      } else {
        cur.push(w);
        len += w.length + 1;
      }
    }

    if (cur.length) out.push(cur.join(' '));
    return out.length ? out : [text];
  }

  private _preClean(text: string): string {
    return text
      // eslint-disable-next-line no-control-regex
      .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f-\x9f]/g, '')
      .replace(/[ \t]+/g, ' ')
      .replace(/\n{3,}/g, '\n\n')
      .trim();
  }
}

export const computeHash = (text: string): string =>
  crypto.createHash('sha256').update(text, 'utf8').digest('hex');

export interface ChunkDict {
  content: string;
  searchText: string;
  hash: string;
  source: string;
  title: string;
  metadata: Record<string, any>;
}

export function chunkDocument(
  text: string,
  source: string,
  title?: string,
  metadata?: Record<string, any>,
): ChunkDict[] {
  const splitter = new TextSplitter();
  const raw = splitter.split(text);
  const seen = new Set<string>();
  const result: ChunkDict[] = [];

  for (const chunkText of raw) {
    const h = computeHash(chunkText);
    if (seen.has(h)) continue;
    seen.add(h);
    result.push({
      content: chunkText,
      searchText: buildSearchText(chunkText),
      hash: h,
      source,
      title: title || source,
      metadata: metadata ?? {},
    });
  }

  return result;
}
