# Enterprise RAG Knowledge Base — 部署与使用指南

本项目是一个 **TypeScript 编写的 RAG 中台**：Fastify 提供 API，PostgreSQL + pgvector 存向量，
检索采用 **稠密（pgvector）+ 稀疏（PG FTS）+ RRF 融合 + CrossEncoder 重排** 的四段式流水线，
生成侧走 OpenAI 兼容协议（vLLM / Ollama / 通义等）。

**它不是一个开箱即用的独立服务** —— Node 进程只负责编排，模型能力必须由两个外部 HTTP 服务提供。
这是部署时最容易踩的坑。

---

## 1. 组件与端口

| 组件 | 端口 | 是否必需 | 说明 |
|------|------|----------|------|
| Fastify API | 9000 | 本项目 | `src/index.ts`，RAG 编排层 |
| PostgreSQL + pgvector | 5432 | **必需** | 存 documents / chunks / 向量 |
| Redis | 6379 | 名义必需 | 已建客户端，但业务代码未使用 |
| Embedding 服务 | 8001 | **必需** | BGE-M3，提供 `/embeddings` 与 `/rerank` |
| LLM 服务 | 8000 | **必需** | OpenAI 兼容 `/v1/chat/completions` |

配置文件集中在 `src/config.ts`，全部走环境变量 + zod 校验，默认值可跑本地开发，
但 `LLM_BASE_URL` / `EMBEDDING_ENDPOINT_URL` 实际部署时必须显式指定。

---

## 2. 部署步骤

### 2.0 前置检查（当前机器状态）

实测本机（macOS）现状：

- Node `v22.22.2` / npm `10.9.7` ✅
- `docker` ❌ 未安装
- `psql` / `pg_isready` / `redis-cli` ❌ 未安装
- `node_modules/` ❌ 未安装
- `.env` ❌ 不存在（已复制 `.env.example` 后可解决）
- `data/` ❌ 不存在（README 的 `--source ./data/` 会静默空转）
- `embed_service.py` ❌ 不存在（但 `scripts/setup.sh` 结尾提示启动它）

> `docker compose up -d` 与 `npm run health` 在当前机器上必然失败，需先补齐运行时。

### 2.1 安装依赖

```bash
npm install
```

### 2.2 启动 PostgreSQL + pgvector

有 Docker 时直接：

```bash
docker compose up -d
```

镜像为 `ankane/pgvector:0.6.0`，首次启动会自动执行 `db/init.sql`（已挂载到
`docker-entrypoint-initdb.d`），建表、建索引、装 `vector` 扩展。

无 Docker 时（当前机器）可选路径：

- 安装 Docker Desktop / OrbStack / Colima 之一；
- 或用 Homebrew 装 `postgresql@16` + `pgvector`，再手动执行 `db/init.sql`：
  ```bash
  psql "$DATABASE_URL" -f db/init.sql
  ```

### 2.3 执行迁移（幂等）

```bash
npm run migrate        # npx ts-node db/migrate.ts
```

脚本以 `_schema_migrations.version = '1.0.0'` 做幂等标记，重复执行会跳过。
它与 2.2 的 `init.sql` 内容一致且都带 `IF NOT EXISTS`，两者重复执行不冲突。

### 2.4 启动 Embedding + Rerank 服务（必需，README 缺失实体文件）

TypeScript 无法直接加载 sentence-transformers，必须起一个 Python 服务。
把下面内容存为项目根目录 `embed_service.py`（README 只贴了代码，仓库里没有这个文件）：

```python
from fastapi import FastAPI
from sentence_transformers import SentenceTransformer, CrossEncoder
from pydantic import BaseModel
import torch

app = FastAPI()
device = "cuda" if torch.cuda.is_available() else "cpu"
model = SentenceTransformer("BAAI/bge-m3").to(device)
reranker = CrossEncoder("BAAI/bge-reranker-v2-m3").to(device)

class EmbedRequest(BaseModel):
    texts: list[str]
    model: str = "BAAI/bge-m3"

class RerankRequest(BaseModel):
    query: str
    passages: list[str]
    top_k: int = 10

@app.get("/health")          # health-check.sh 会探测此路由，README 原版缺失
def health():
    return {"status": "ok"}

@app.post("/embeddings")
async def embed(req: EmbedRequest):
    return {"embeddings": model.encode(req.texts, convert_to_list=True).tolist()}

@app.post("/rerank")
async def rerank(req: RerankRequest):
    pairs = [(req.query, p) for p in req.passages]
    scores = reranker.predict(pairs)
    results = [{"index": i, "score": float(s)} for i, s in enumerate(scores)]
    results.sort(key=lambda x: x["score"], reverse=True)
    return {"results": results[:req.top_k]}

if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=8001)
```

```bash
pip install "fastapi[all]" sentence-transformers
python embed_service.py
```

> 首次运行会下载 BGE-M3（约 2GB）与 reranker。CPU 模式下单批 64 条约数秒到数十秒，
> `src/embeddings.ts` 的 axios 超时是 60s，语料大时可能触发。

### 2.5 启动 LLM 服务（OpenAI 兼容）

默认 `LLM_BASE_URL=http://localhost:8000/v1`、`LLM_MODEL_NAME=Qwen/Qwen1.5-7B-Chat`。
任选其一：vLLM、Ollama（`--openai` 兼容模式）、或任何 OpenAI 协议网关。
健康检查会请求 `{LLM_BASE_URL}/models`。

### 2.6 灌库

先把待索引文档放到 `data/`（`.gitignore` 已忽略该目录）：

```bash
npm run ingest -- --source ./data/
# 单文件：npm run ingest -- --file ./docs/handbook.pdf
# 指定权限标签：npx ts-node src/ingest.ts --source ./data/ --tags public,finance
# 换嵌入模型后重建向量：npm run ingest -- --reindex
```

支持的扩展名：`.pdf .docx .doc .txt .md .html .htm`。

### 2.7 启动 API

```bash
npm run dev      # ts-node 直跑源码
# 生产：npm run build && npm start
```

### 2.8 验证

```bash
curl http://localhost:9000/health
curl http://localhost:9000/api/v1/admin/metrics
```

`npm run health` 依赖本机 `pg_isready` / `redis-cli`，当前机器不可用。

---

## 3. 使用方式

### 3.1 非流式问答

```bash
curl -X POST http://localhost:9000/api/v1/chat \
  -H 'Content-Type: application/json' \
  -d '{
    "query": "报销流程是怎样的？",
    "session_id": "11111111-1111-1111-1111-111111111111",
    "user_tags": ["public"],
    "history": []
  }'
```

返回 `{ answer, citations: [{chunk_id, source, content, score}], model }`。

### 3.2 流式问答（SSE）

```bash
curl -N -X POST http://localhost:9000/api/v1/chat/stream \
  -H 'Content-Type: application/json' \
  -d '{"query":"报销流程是怎样的？"}'
```

事件序列：`metadata` → 若干 `token` → `citations` → `done`。

### 3.3 上传并索引文档

```bash
curl -X POST http://localhost:9000/api/v1/documents \
  -F "file=@./handbook.pdf" \
  -F "title=员工手册" \
  -F "access_tags=[\"public\"]"
```

返回 201：`{ document_id, chunks_created, title, latency_ms }`。单文件上限 100MB。

### 3.4 其余端点

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/api/v1/documents/{id}` | 文档元数据 + chunk 数 |
| DELETE | `/api/v1/documents/{id}` | 删文档，chunks 由外键级联删除 |
| GET | `/api/v1/admin/metrics` | 文档数 / chunk 数 / uptime |
| GET | `/health` | 存活探测 |

### 3.5 权限模型

`chunks.access_tags` 是 `TEXT[]`。检索时 `applyAccessFilter` 的规则是：

- 不传 `user_tags` → 只返回含 `public` 标签的 chunk；
- 传了 `user_tags` → 返回标签**交集非空**的 chunk（不再默认放行 `public`，
  如需放行请显式把 `public` 放进 `user_tags`）。

灌库默认打 `public`（`ingest.ts:12`、上传接口 `index.ts:239`）。

---

## 4. 已知问题与修复建议

### P0 — 不处理就跑不通或有正确性风险

| # | 位置 | 问题 | 建议 |
|---|------|------|------|
| 1 | `db/init.sql:27` | ivfflat 索引声明 `vector_ip`（内积），但 `retriever.ts:62` 用 `<=>`（余弦距离）排序。算子与索引不匹配 → **索引完全失效，退化为全表扫描** | 改为 `USING ivfflat (embedding vector_cosine_ops)`，或把排序改成 `<=>` 对应的 `vector_cosine_ops` |
| 2 | `db/init.sql:33`、`src/retriever.ts:78` | FTS 固定 `to_tsvector('english', ...)`。**中文语料几乎无法分词**，稀疏分支召回趋近于零，混合检索实际只剩稠密一路 | 中文场景改用 `'simple'`，或装 `pg_jieba` / `zhparser` 并配套改查询 |
| 3 | `src/retriever.ts:164` | `RERANK_THRESHOLD` 在 config 中定义但**从未使用**，低分噪声不过滤 | 重排后 `if (score < config.RERANK_THRESHOLD) continue;` |
| 4 | `src/index.ts:222-241` | 先插 `documents`，再在循环里逐条 `await` 插 chunk，**无事务**。中途失败会留下无 chunk 的孤儿文档；大文档入库是 N 次串行往返，很慢 | 包一个事务 + 批量 INSERT（`VALUES (...),(...)`）或 `COPY` |
| 5 | `src/index.ts:238` | `ON CONFLICT (hash) DO NOTHING` 且 `hash` 是**全局唯一**的内容哈希。不同文档中的相同段落会被静默丢弃，而 `chunks_created` 仍按 chunk 总数上报 → 计数虚高 | 去重键改为 `(doc_id, hash)`，或按实际 `rowCount` 统计 |
| 6 | `src/index.ts:47` | `/health` 里 `vector_db: 'connected'` 是硬编码，**从不真正探测数据库** | 加一次 `SELECT 1` |
| 7 | `src/parsers.ts:114` | 灌库默认开启 PII 脱敏，会把邮箱/电话/卡号替换成占位符 → **库里存的内容与原文不一致**，回答引用的是脱敏后文本 | 明确为产品决策；如需原文溯源，加开关 |

### P1 — 影响可维护性 / 安全

| # | 位置 | 问题 | 建议 |
|---|------|------|------|
| 8 | `src/db.ts:15` | Redis 客户端建了，但业务代码零使用；`audit.ts:31` 的 `rateLimit` 是 `return true` 占位 | 要么落地限流/缓存，要么摘掉依赖 |
| 9 | `db/init.sql:36`、`src/middleware/audit.ts` | `chat_history` / `audit_log` 表已建，但**从未写入**；`auditLogger` 也没在 `index.ts` 注册 | 挂 hook 或删除 |
| 10 | `src/index.ts:35`、`310` | CORS `origin: true` + `credentials: true`；`/admin/metrics` 与上传接口**无任何鉴权** | 生产改为白名单 + API Key / JWT |
| 11 | 根目录 | 无 ESLint 配置文件，`npm run lint` 必然失败 | 补 `.eslintrc.cjs` 或从 package.json 移除脚本 |
| 12 | `scripts/health-check.sh:26` | 探测 `:8001/health`，但 README 给的 Python 服务没有该路由 → 恒为 FAIL | 已在本文档 2.4 的示例里补上 `/health` |
| 13 | `db/migrate.ts:42` | `schema.split(';')` 切分 SQL，遇到字符串/函数体内的分号即崩 | 用 `pg` 的多语句直传，或引入 SQL 解析器 |
| 14 | `src/index.ts:149` | SSE 用 `reply.raw.write` 且未处理背压，客户端断开时可能悬挂 | 监听 `reply.raw.on('close')` 终止生成 |
| 15 | README | 步骤 4 的 `--source ./data/` 指向不存在的目录，无输出也**不报错** | 建 `data/` 或改示例路径 |

### 已确认无问题

- `VECTOR_DIMS = 1024` 与 BGE-M3 输出维度一致，入库前有 `slice(0, 1024)` 兜底。
- `documents` 删除通过外键 `ON DELETE CASCADE` 正确级联清理 chunks。
- `init.sql` 与 `migrate.ts` 内容重复但均为幂等（`IF NOT EXISTS`），不会互相破坏。

---

## 5. 生产部署要点

1. `NODE_ENV=production`，用 `npm run build` 产出 `dist/` 后 `node dist/index.js`，避免 ts-node 常驻。
2. 数据库不要用 `docker-compose.yml` 里的默认口令，通过 `DB_PASSWORD` 注入。
3. ivfflat 索引的 `lists = 100` 是按数据量预设的，导入完大批量数据后**重建索引**以保召回：
   ```sql
   SET maintenance_work_mem = '2GB';
   CREATE INDEX CONCURRENTLY chunks_embedding_idx
     ON chunks USING ivfflat (embedding vector_cosine_ops) WITH (lists = 500);
   ```
4. 进程已处理 `SIGTERM` / `SIGINT` 优雅关闭，容器化时注意留出关闭窗口。
5. 上传接口 100MB 上限 + 同步解析，生产建议前置对象存储与异步任务队列。
