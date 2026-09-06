// src/parsers.ts
import { readFile } from 'fs/promises';
import path from 'path';
import { spawn } from 'child_process';

// Simple language detection
export function detectLanguage(text: string): 'zh' | 'en' | 'unknown' {
  const cjk = (text.match(/[\u4e00-\u9fff]/g) || []).length;
  const total = text.length;
  if (total === 0) return 'unknown';
  return cjk / total > 0.1 ? 'zh' : 'en';
}

// PII scrubbing
const PII_PATTERNS: [RegExp, string][] = [
  [/\b\d{3}-\d{2}-\d{4}\b/g, '[SSN]'],
  [/\b\d{16,19}\b/g, '[CARD]'],
  [/\b[\w.+-]+@[\w.-]+\.\w{2,}\b/g, '[EMAIL]'],
  [/\b\d{3}-\d{4}-\d{4}\b/g, '[PHONE]'],
];

export function scrubPii(text: string): string {
  for (const [pattern, replacement] of PII_PATTERNS) {
    text = text.replace(pattern, replacement);
  }
  return text;
}

// PDF parser
export async function parsePdf(filePath: string): Promise<string> {
  try {
    const { default: pdfParse } = await import('pdf-parse');
    const data = await readFile(filePath);
    const pdfData = await pdfParse(data);
    return pdfData.text;
  } catch (err) {
    console.warn('Falling back to pdftotext for PDF:', (err as Error).message);
    return await execCommand('pdftotext', [filePath, '-']);
  }
}

// DOCX parser
export async function parseDocx(filePath: string): Promise<string> {
  try {
    const { default: mammoth } = await import('mammoth');
    const result = await mammoth.extractRawText({ path: filePath });
    return result.value;
  } catch (err) {
    console.warn('Falling back to docx2txt for DOCX:', (err as Error).message);
    return await execCommand('docx2txt', [filePath, '-']);
  }
}

// Text parser
export async function parseText(filePath: string): Promise<string> {
  return await readFile(filePath, 'utf-8');
}

// HTML parser
export async function parseHtml(filePath: string): Promise<string> {
  const html = await readFile(filePath, 'utf-8');
  return html
    .replace(/<script[^>]*>.*?<\/script>/gi, '')
    .replace(/<style[^>]*>.*?<\/style>/gi, '')
    .replace(/<[^>]+>/g, '\n')
    .replace(/\n+/g, '\n\n')
    .trim();
}

// Utility: execute external command
function execCommand(cmd: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args);
    let output = '';

    child.stdout.on('data', (data: Buffer) => {
      output += data.toString();
    });

    child.stderr.on('data', () => {
      // Capture stderr but don't fail unless command exits with error
    });

    child.on('close', (code: number) => {
      if (code !== 0) {
        reject(new Error(`${cmd} exited with code ${code}`));
      } else {
        resolve(output);
      }
    });
  });
}

const PARSERS: Record<string, (f: string) => Promise<string>> = {
  '.pdf': parsePdf,
  '.docx': parseDocx,
  '.doc': parseDocx,
  '.txt': parseText,
  '.md': parseText,
  '.html': parseHtml,
  '.htm': parseHtml,
};

export async function parseDocument(filePath: string, scrub: boolean = true): Promise<{ text: string; lang: string }> {
  const ext = path.extname(filePath).toLowerCase();
  const parser = PARSERS[ext];

  if (!parser) {
    throw new Error(`Unsupported file type: ${ext}`);
  }

  let text = await parser(filePath);

  if (scrub) {
    text = scrubPii(text);
  }

  const lang = detectLanguage(text);
  return { text, lang };
}
