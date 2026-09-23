// src/crypto.ts
// 落库内容加密（应用层 AES-256-GCM，密钥仅存于服务端 config，绝不入库）。
// 目的：敏感切片的内容在 DB 侧只以密文（content_enc）留存，
// 即使 DBA / 直接读库者拿到数据也看不到明文 PII；应用持有密钥，读时解密后做呈现/遮盖。
import crypto from 'crypto';
import { config } from './config';

const ALGO = 'aes-256-gcm';
const IV_LEN = 12;
const TAG_LEN = 16;

let cachedKey: Buffer | null = null;
let cachedMissing = false;

// 从环境变量解析 32 字节密钥：支持 64 位 hex、32 字节 base64、或任意口令（派生）。
function getKey(): Buffer | null {
  if (cachedMissing) return null;
  if (cachedKey) return cachedKey;
  const raw = config.CONTENT_ENCRYPTION_KEY?.trim();
  if (!raw) {
    cachedMissing = true;
    return null;
  }
  try {
    if (/^[0-9a-fA-F]{64}$/.test(raw)) {
      cachedKey = Buffer.from(raw, 'hex');
      return cachedKey;
    }
    const b = Buffer.from(raw, 'base64');
    if (b.length === 32) {
      cachedKey = b;
      return cachedKey;
    }
    // 任意口令：派生 32 字节，保证可用
    cachedKey = crypto.createHash('sha256').update(raw, 'utf8').digest();
    return cachedKey;
  } catch {
    cachedMissing = true;
    return null;
  }
}

// 明文 -> base64( iv | authTag | ciphertext )。无密钥时退化为明文透传（开发/未配置态）。
export function encryptContent(plain: string): string {
  const k = getKey();
  if (!k) return plain;
  const iv = crypto.randomBytes(IV_LEN);
  const cipher = crypto.createCipheriv(ALGO, k, iv);
  const enc = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, enc]).toString('base64');
}

// base64 密文 -> 明文；无密文时回落 fallback（兼容旧库明文 content / 非敏感切片）。
// 解密失败（如密钥不匹配或数据损坏）回落 fallback，避免向上抛错中断检索。
export function decryptContent(cipherB64: string | null | undefined, fallback?: string): string {
  if (!cipherB64) return fallback ?? '';
  const k = getKey();
  if (!k) return cipherB64; // 无密钥且本是明文透传
  try {
    const buf = Buffer.from(cipherB64, 'base64');
    const iv = buf.subarray(0, IV_LEN);
    const tag = buf.subarray(IV_LEN, IV_LEN + TAG_LEN);
    const enc = buf.subarray(IV_LEN + TAG_LEN);
    const decipher = crypto.createDecipheriv(ALGO, k, iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(enc), decipher.final()]).toString('utf8');
  } catch {
    return fallback ?? '';
  }
}
