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

## 2. Docker 部署（推荐）

项目已提供 `Dockerfile` 与 `docker-compose.yml`，支持一键部署全部依赖。

### 2.2.1 Docker Compose 启动

```bash
# 1. 复制环境变量模板
cp .env.docker.example .env
# 按需修改 .env（生产环境必填 API_KEY / ADMIN_API_KEY）

# 2. 构建镜像
docker compose build

# 3. 启动全部服务
docker compose up -d
```

compose 包含 5 个服务：

| 服务 | 端口 | 说明 |
|------|------|------|
| db | 5432 | PostgreSQL + pgvector |
| redis | 6379 | Redis（限流） |
| embed-server | 8001 | BGE-M3 embedding + rerank（纯 Node ONNX） |
| api | 9000 | Fastify RAG API |
| llm | 8000 | Ollama（可选） |

startup order：db + redis → embed-server → migrate（一次性）→ api。

### 2.2.2 LLM 服务

默认 `llm` 服务运行 Ollama。首次启动后需手动拉取模型：

```bash
# 拉取模型
docker exec -it rag-llm ollama run Qwen1.5-7B-Chat
# 然后 API 就可以通过 http://llm:8000/v1 访问
```

如已有 LLM 服务（vLLM 等），可在 `.env` 中设置 `LLM_BASE_URL=http://your-llm:8000/v1`，并在 `docker compose up -d` 时跳过 `llm` 服务：

```bash
docker compose up -d db redis embed-server api   # 不启动 llm 服务
```

### 2.1 安装依赖

```bash
npm install
```

### 2.2 启动 PostgreSQL + pgvector

有 Docker 时直接：

```bash
docker compose up -d
```

镜像为 `ankane/pgvector:0.6.0`。**注意**：本项目不依赖容器的 `docker-entrypoint-initdb.d` 自动初始化，
建表 / 建索引 / 装 `vector` 扩展统一由 `npm run migrate`（即 `db/migrate.ts`）完成，请遵循 2.3 步。

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

脚本以 `_schema_migrations.version = '1.1.0'` 做幂等标记，重复执行会跳过主体。
它与 2.2 的 `init.sql` 内容一致且都带 `IF NOT EXISTS`，两者重复执行不冲突；
同时包含对 1.0.0 存量库的原地升级（加列 / 换唯一键 / 重建索引）。

### 2.4 启动 Embedding + Rerank 服务（必需，纯 Node 实现）

本项目自带**纯 Node** 的嵌入 / 重排服务 `src/embed_server.ts`，底层用 `@huggingface/transformers`
（ONNX Runtime）直接加载 BGE-M3 / bge-reranker 的 ONNX 权重，**不再依赖任何 Python 环境**。
对外接口（`/embeddings`、`/rerank`、`/health`）与旧版 Python 服务一致，`src/embeddings.ts` 无需改动。

```bash
npm run embed-server        # 默认监听 :8001
```

首次运行会从 HuggingFace 下载权重。**建议先用下载脚本把权重拉到本地**：

```bash
npm run download-models     # 下到 ./models（约 1.1 GB）
MODELS_DIR=./models npm run embed-server
```

脚本默认走 **ModelScope（国内源）**，自带 16 MB 分片 + 失败重试 + 断点续传。

> **为什么不用 transformers.js 自带的下载？**
> HuggingFace 已把 LFS 迁到 Xet 存储，`resolve` 会 302 到境外 CDN（`us.aws.cdn.hf.co`），
> 对分片请求（Range）直接返回 **400**，流式读取也会在几 MB 处被切断，
> 最终表现为 ONNX Runtime 抛 `terminated` —— 极难排查。
> `HF_ENDPOINT=https://hf-mirror.com` 同样会跳到该 CDN，并不能解决。
> 换源：`MODEL_SOURCE=huggingface npm run download-models`。

> **dtype 必须真实存在于仓库**：dtype 会映射到 `onnx/model_<dtype>.onnx`。
> `Xenova/bge-m3` 与 `onnx-community/bge-reranker-v2-m3-ONNX` **都没有 `q8` 档位**，
> 填 `q8` 会静默回退到 fp32，而 fp32 权重在外部数据文件 `onnx/model.onnx_data`（2.2 GB）里，
> 缺它同样只报 `terminated`。默认已改为 **`int8`**（单文件自包含，约 545 MB，CPU 推理最快）。
> 可选档位：`int8`(545 MB) / `q4f16` / `q4`(1.2 GB) / `fp16`(1.1 GB) / `fp32`(2.2 GB + 外部数据)。

> 可用环境变量覆盖：`EMBED_SERVER_PORT`（默认 8001）、`EMBED_MODEL_ID`（默认 `Xenova/bge-m3`）、
> `RERANK_MODEL_ID`（默认 `onnx-community/bge-reranker-v2-m3-ONNX`）、`EMBED_DTYPE`/`RERANK_DTYPE`
> （默认 `int8`）、`MODELS_DIR`（默认 `./models`）、`EMBED_DEVICE`/`RERANK_DEVICE`（默认空=CPU）、
> `EMBED_MAX_LENGTH`、`RERANK_MAX_LENGTH`。
> `src/embeddings.ts` 的 axios 超时是 60s，语料大时可能触发。

> 权重默认落在 `./models`（`.gitignore` 已忽略）。Docker 部署时该目录会被挂载到 `/app/models`，
> 容器无需联网即可加载。若目录为空，服务才会回退到远程下载。

### 2.5 启动 LLM 服务（OpenAI 兼容）

默认 `LLM_BASE_URL=http://localhost:8000/v1`、`LLM_MODEL_NAME=Qwen/Qwen1.5-7B-Chat`。
任选其一：vLLM、Ollama（`--openai` 兼容模式）、或任何 OpenAI 协议网关。
健康检查会请求 `{LLM_BASE_URL}/models`。

> **`docker pull` 大镜像反复失败？**
> 若看到 `short read: expected 3250030508 bytes but got 140279039: unexpected EOF`，
> 说明本机出网对**单条长连接的大流量传输**不稳定（换国内 registry 镜像源也一样，
> 只是断点位置略变）。用仓库自带的分段拉取脚本绕开：
>
> ```bash
> # 在容器内执行（容器出网通常比宿主机宽松）
> docker run --rm -v "$PWD/images:/out" -v "$PWD/scripts/pull-image.mjs:/app/pull-image.mjs:ro" \
>   rag-embed-server:latest node /app/pull-image.mjs ollama/ollama --out /out
>
> cd images/.work-ollama_ollama && tar cf ../ollama-ollama.tar . && cd ..
> docker load -i ollama-ollama.tar
> ```
>
> 脚本用 16 MB 分片 + 失败重试 + 断点续传直连 registry，再组装成 `docker-archive` 导入。
> 中断后重跑会自动续传，不用从头开始。

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

灌库默认打 `public`（ingest 与上传接口均在入库时落 `['public']` 标签）。

---

## 4. 已修复问题记录（v1.1.0）

> 以下 P0 / P1 条目在 v1.1.0 中已全部修复，此处保留记录便于审计与回滚核查。

### P0 — 正确性 / 性能

| # | 位置 | 问题 | 建议 | 状态 |
|---|------|------|------|------|
| 1 | `db/init.sql` | ivfflat 索引声明 `vector_ip`（内积），但排序用 `<=>`（余弦距离） → 索引失效 | 改为 `USING ivfflat (embedding vector_cosine_ops)` | ✅ 已修复：`init.sql:32` 已是 `vector_cosine_ops`（附注释说明原因） |
| 2 | `db/init.sql`、`src/retriever.ts` | FTS 固定 `to_tsvector('english', ...)`，中文语料几乎无法分词，稀疏分支召回趋零 | 中文场景改用 `'simple'` 或 CJK 分词 | ✅ 已修复：新增 `chunks.search_text` 列 + 应用层 CJK bigram 分词（`src/tokenize.ts`），GIN 索引建在 `to_tsvector('simple', search_text)`；`npm run backfill-text` 可回填存量 |
| 3 | `src/retriever.ts` | `RERANK_THRESHOLD` 定义但未使用，低分噪声不过滤 | 重排后按阈值过滤 | ✅ 已修复：`retriever.ts:176` `if (score < config.RERANK_THRESHOLD) continue;` |
| 4 | `src/indexer.ts` | 入库无事务、逐条 `await` 插 chunk，易留孤儿文档且慢 | 包事务 + 批量 INSERT | ✅ 已修复：`indexer.ts:54` 起 `BEGIN`…批量 `VALUES (...)` 提交 |
| 5 | `src/indexer.ts` | `ON CONFLICT (hash)` 全局唯一键，跨文档相同段落被静默丢弃，计数虚高 | 去重键改为 `(doc_id, hash)` | ✅ 已修复：`indexer.ts:92` `ON CONFLICT (doc_id, hash) DO NOTHING`，并返回真实落库行数 |
| 6 | `src/index.ts` | `/health` 中 `vector_db: 'connected'` 硬编码，从不真正探测 | 加 `SELECT 1` 探针 | ✅ 已修复：`/health` 已对 db / redis / llm 三路真实探测 |
| 7 | `src/parsers.ts` | 灌库默认开启 PII 脱敏，库内容与原文不一致 | 明确决策或加开关 | ✅ 已修复：`config.SCRUB_PII` 与 `parseDocument` 默认均为 `false`，默认存原文；两处调用点均显式传参 |

### P1 — 影响可维护性 / 安全

| # | 位置 | 问题 | 建议 | 状态 |
|---|------|------|------|------|
| 8 | `src/db.ts`、`src/ratelimit.ts` | Redis 客户端建了，但业务代码零使用；`audit.ts` 的 `rateLimit` 是 `return true` 占位 | 要么落地限流/缓存，要么摘掉依赖 | ✅ 已修复：`src/ratelimit.ts` 基于 Redis 滑动窗口实现真实限流（`RATE_LIMIT_*` 可配），`index.ts` 的 chat/stream/upload 路由已接入 |
| 9 | `db/init.sql`、`src/middleware/audit.ts` | `chat_history` / `audit_log` 表已建，但**从未写入**；`auditLogger` 也没在 `index.ts` 注册 | 挂 hook 或删除 | ✅ 已修复：`index.ts` 通过 `onResponse` hook 注册 `auditLogger`，问答后写入 `chat_history`（由 `CHAT_HISTORY_ENABLED` 控制） |
| 10 | `src/index.ts` | CORS `origin: true` + `credentials: true`；`/admin/metrics` 与上传接口**无任何鉴权** | 生产改为白名单 + API Key / JWT | ✅ 已修复：CORS 改白名单（`CORS_ORIGIN`，`*` 时关闭 credentials）；`/api/v1/admin/*` 强制 `ADMIN_API_KEY`（fail-closed）；`API_KEY` 非空时全接口鉴权 |
| 11 | 根目录 | 无 ESLint 配置文件，`npm run lint` 必然失败 | 补 `.eslintrc.cjs` 或从 package.json 移除脚本 | ✅ 已修复：新增 `.eslintrc.cjs`，`lint` 脚本范围扩到 `src/ db/` |
| 12 | `scripts/health-check.sh` | 探测 `:8001/health`，但原 README 的 Python 服务没有该路由 → 恒为 FAIL | 补 `/health` 路由 | ✅ 已修复：embedding 服务已改为纯 Node（`src/embed_server.ts`），自带 `GET /health`；health-check 对依赖失败降级为 WARNING |
| 13 | `db/migrate.ts` | `schema.split(';')` 切分 SQL，遇到字符串/函数体内的分号即崩 | 用 `pg` 的多语句直传，或引入 SQL 解析器 | ✅ 已修复：`init.sql` 整体交给 `pg` 多语句直传；并对空库调整执行顺序（`init.sql` 在 `applySchemaUpgrades` 之前） |
| 14 | `src/index.ts` | SSE 用 `reply.raw.write` 且未处理背压，客户端断开时可能悬挂 | 监听 `reply.raw.on('close')` 终止生成 | ✅ 已修复：流式生成监听 `reply.raw` 的 `close` 事件，断连即 `stream.destroy()` 终止 |
| 15 | README | 步骤 4 的 `--source ./data/` 指向不存在的目录，无输出也**不报错** | 建 `data/` 或改示例路径 | ✅ 已修复：仓库已建 `data/`（含 `.gitkeep`），`npm run ingest -- --source ./data/` 路径有效 |

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
