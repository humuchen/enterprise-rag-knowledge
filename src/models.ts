// src/models.ts

export interface DocumentRecord {
  id: string;
  source: string;
  title: string | null;
  metadata: Record<string, any>;
  created_at: Date;
}

export interface ChunkRecord {
  id: string;
  doc_id: string;
  content: string;
  hash: string;
  metadata: Record<string, any>;
  embedding: number[];
  access_tags: string[];
  created_at: Date;
  updated_at: Date;
}

export interface ChatMessageRecord {
  id: string;
  session_id: string;
  role: 'user' | 'assistant';
  content: string;
  sources: any[];
  created_at: Date;
}

export interface AuditLogRecord {
  id: string;
  user_id: string | null;
  action: string;
  doc_id: string | null;
  query: string | null;
  retrieved_ids: string[];
  response: string | null;
  latency_ms: number;
  created_at: Date;
}
