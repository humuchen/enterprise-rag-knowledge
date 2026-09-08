# RAG 接口文档

## 服务地址
- API 服务: `http://localhost:9000`
- Embedding 服务: `http://localhost:8001`

## 接口列表

### 1. 健康检查
**GET** `/health`

检查服务状态，返回各依赖组件健康情况。

**响应:** `200`
```json
{
  "status": "healthy",       // healthy | degraded
  "vector_db": "connected",   // PostgreSQL + pgvector
  "redis": "connected",       // Redis 连接
  "llm_endpoint": "ok",      // LLM 服务
  "version": "1.1.0"
}
```

---

### 2. 非流式聊天
**POST** `/api/v1/chat`

RAG 问答接口，检索相关文档并调用 LLM 生成答案。

**请求体:** `application/json`
```json
{
  "query": "报销流程是怎样的？",
  "session_id": "11111111-1111-1111-1111-111111111111",  // 可选，自动生成
  "user_tags": ["public"],                                  // 可选，权限标签
  "history": [                                              // 可选，对话历史
    {"role": "user", "content": "你好"},
    {"role": "assistant", "content": "你好，有什么可以帮助你的吗？"}
  ]
}
```

**响应:** `200`
```json
{
  "answer": "报销流程是...",
  "citations": [
    {
      "chunk_id": "uuid-string",
      "source": "财务制度.pdf",
      "content": "报销流程第一步...",
      "score": 0.89
    }
  ],
  "model": "Qwen/Qwen1.5-7B-Chat",
  "latency_ms": 1234
}
```

---

### 3. 流式聊天 (SSE)
**POST** `/api/v1/chat/stream`

服务器发送事件流式响应，逐 token 返回。

**请求体:** 同 `/api/v1/chat`

**事件流格式:**
```
event: metadata
data: {"type":"metadata","session_id":"uuid","chunks_retrieved":5}

event: token
data: {"type":"token","content":"报"}

event: token
data: {"type":"token","content":"销"}

event: citations
data: {"type":"citations","items":[{"chunk_id":"uuid","source":"...","score":0.89,"content":"..."}]}

event: done
data: {"type":"done","latency_ms":1234}
```

**curl 示例:**
```bash
curl -N -X POST http://localhost:9000/api/v1/chat/stream \
  -H 'Content-Type: application/json' \
  -d '{"query":"报销流程是怎样的？"}'
```

---

### 4. 上传文档
**POST** `/api/v1/documents`

上传并索引文档 (PDF, DOCX, DOC, TXT, MD, HTML, HTM 等)。

**请求:** `multipart/form-data`
| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| file | 文件 | ✅ | 文档文件，最大 100MB |
| title | 字符串 | ❌ | 文档标题 |
| access_tags | JSON 数组 | ❌ | 权限标签，如 `["public","finance"]` |

**响应:** `201`
```json
{
  "document_id": "uuid-string",
  "chunks_created": 15,
  "chunks_total": 15,
  "title": "员工手册.pdf",
  "latency_ms": 4567
}
```

**curl 示例:**
```bash
curl -X POST http://localhost:9000/api/v1/documents \
  -F "file=@./data/guide.pdf" \
  -F "title=员工手册" \
  -F 'access_tags=["public","hr"]'
```

---

### 5. 查询文档
**GET** `/api/v1/documents/{doc_id}`

获取文档元信息和 chunk 数量。

**响应:** `200`
```json
{
  "id": "uuid-string",
  "source": "guide.pdf",
  "title": "员工手册",
  "metadata": {"original_filename": "guide.pdf"},
  "chunk_count": 23,
  "created_at": "2026-09-08T12:00:00Z"
}
```

**响应:** `404` — 文档不存在
```json
{"error": "Document not found"}
```

---

### 6. 删除文档
**DELETE** `/api/v1/documents/{doc_id}`

删除文档及其关联的所有 chunks (级联删除)。

**响应:** `200`
```json
{
  "status": "deleted",
  "document_id": "uuid-string"
}
```

**响应:** `404` — 文档不存在
```json
{"error": "Document not found"}
```

---

### 7. 管理指标 (需要鉴权)
**GET** `/api/v1/admin/metrics`

获取知识库统计信息。

**请求头:**
```
x-api-key: your-admin-api-key
```

**响应:** `200`
```json
{
  "documents_total": 5,
  "chunks_total": 127,
  "uptime": 3600.5
}
```

**响应:** `503` — 未配置管理员密钥
```json
{"error": "Admin endpoints disabled: ADMIN_API_KEY is not configured"}
```

---

## Embedding 服务接口 (端口 8001)

### 8. Embedding 服务健康检查
**GET** `/health`

**响应:** `200`
```json
{
  "status": "ok",
  "embedding": "Xenova/bge-m3",
  "reranker": "onnx-community/bge-reranker-v2-m3-ONNX"
}
```

---

### 9. Embedding 向量生成
**POST** `/embeddings`

调用 BGE-M3 生成文本向量。

**请求体:**
```json
{
  "texts": ["hello world", "another sentence"],
  "model": "Xenova/bge-m3"
}
```

**响应:** `200`
```json
{
  "embeddings": [[0.1, -0.2, 0.3, ...], [0.4, -0.1, 0.5, ...]]
}
```

---

### 10. Rerank 重排序
**POST** `/rerank`

对检索结果进行相关性重排序。

**请求体:**
```json
{
  "query": "报销流程",
  "passages": ["报销流程第一步...", "另一篇文档...", "关于会议的..."],
  "top_k": 5
}
```

**响应:** `200`
```json
{
  "results": [
    {"index": 0, "score": 0.92},
    {"index": 1, "score": 0.34},
    {"index": 2, "score": 0.12}
  ]
}
```

---

## 服务端口对照

| 服务 | 容器端口 | 宿主机端口 | 说明 |
|------|---------|-----------|------|
| db | 5432 | 5432 | PostgreSQL + pgvector |
| redis | 6379 | 6379 | Redis (限流) |
| embed-server | 8001 | 8001 | BGE-M3 embedding + rerank |
| api | 9000 | 9000 | Fastify RAG API |
| llm | 8000 | 8000 | Ollama (可选) |

容器内部服务通过 Docker DNS 名称互相访问:
- `api` → embed-server: `http://embed-server:8001`
- `api` → db: `postgresql://rag:***@db:5432/ragdb`
- `api` → redis: `redis://redis:6379`
- `api` → LLM: `http://llm:8000/v1`

---

## 鉴权说明

| 配置项 | 说明 |
|--------|------|
| `API_KEY` | 为空时 `/api/v1/*` 开放；设置后需在请求头 `x-api-key` 提供 |
| `ADMIN_API_KEY` | 强制要求对 `/api/v1/admin/*` 进行鉴权；未设置则接口返回 503 |
| `CORS_ORIGIN` | CORS 白名单，逗号分隔；`*` 表示允许任意来源 |

---

## 文档摄入 CLI

在容器内执行:
```bash
# 进入 api 容器
docker compose exec api sh

# 批量导入 data/ 目录下的文档
node dist/db/migrate.js && node dist/src/ingest.js --source /app/data

# 导入单个文件
node dist/src/ingest.js --file /app/data/guide.pdf

# 重新索引所有文档 (更换 embedding 模型后)
node dist/src/ingest.js --reindex

# 回填中文分词文本
node dist/src/ingest.js --backfill-text
```