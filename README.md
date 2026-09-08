# 企业级 RAG 知识库

生产可用的 RAG 技术栈：**Fastify + PostgreSQL/pgvector + BGE-M3**。

检索链路为四段式：稠密向量（pgvector）+ 稀疏检索（PG 全文）+ RRF 融合 + CrossEncoder 重排；
生成侧走 OpenAI 兼容协议（vLLM / Ollama / 通义等）。

## 快速开始

```bash
# 1. 启动 PostgreSQL + Redis
docker compose up -d

# 2. 安装依赖
npm install

# 3. 建库建表
npm run migrate          # 等价于 npx ts-node db/migrate.ts

# 4. 灌入文档（需先启动 embedding 服务）
npm run ingest -- --source ./data/

# 5. 启动 API
npm run dev              # 等价于 npx ts-node src/index.ts
```

> ⚠️ 步骤 4、5 依赖两个**外部模型服务**（embedding/rerank 与 LLM），
> 未启动时接口会报错。详见下方「外部模型服务」。

## 架构

| 组件 | 端口 | 说明 |
|------|------|------|
| Fastify API | 9000 | 编排层，本项目主体 |
| PostgreSQL + pgvector | 5432 | 文档、切片、向量存储与混合检索 |
| Redis | 6379 | 已建客户端，业务代码暂未使用 |
| Embedding / Rerank 服务 | 8001 | 见 `EMBEDDING_ENDPOINT_URL`、`RERANK_ENDPOINT_URL` |
| LLM 服务 | 8000 | OpenAI 兼容，见 `LLM_BASE_URL` |

配置统一在 `src/config.ts`，基于环境变量 + zod 校验；
复制 `.env.example` 为 `.env` 后按需修改。

## 接口

| 方法 | 路径 | 说明 |
|------|------|------|
| POST | `/api/v1/chat` | RAG 问答（非流式） |
| POST | `/api/v1/chat/stream` | 流式问答（SSE） |
| POST | `/api/v1/documents` | 上传并索引文档 |
| GET | `/api/v1/documents/{id}` | 查询文档元数据 |
| DELETE | `/api/v1/documents/{id}` | 删除文档及其切片 |
| GET | `/api/v1/admin/metrics` | 可观测性指标 |
| GET | `/health` | 健康检查 |

## 外部模型服务

Node 侧**不加载模型**，只通过 HTTP 调用，因此有两个必需的服务：

1. **Embedding / Rerank 服务**：`BAAI/bge-m3` 与 `BAAI/bge-reranker-v2-m3`。
   这两个模型本身没有原生 Node 库，但都有官方 ONNX 权重，可经 `@huggingface/transformers`
   （底层 ONNX Runtime）在 Node 里直接加载——**仓库已内置纯 Node 实现**
   [`src/embed_server.ts`](./src/embed_server.ts)，无需任何 Python 环境：

   ```bash
   npm install
   npm run embed-server      # 默认监听 :8001，提供 /embeddings、/rerank、/health
   ```

   接口契约与任意 OpenAI 兼容实现一致；若想换更快/更小的模型，改环境变量
   `EMBED_MODEL_ID`（并同步 `db/init.sql` 的向量维度）即可。
   模型切换、量化档位、国内镜像下载等见 [部署文档 2.4 节](./docs/DEPLOY.md)。
2. **LLM 服务**：任意 OpenAI 兼容后端即可，纯 HTTP，无 Node/Python 依赖。

## 目录说明

```
src/          API 与 RAG 流水线（TypeScript）
  config.ts     环境变量与 zod 校验
  embeddings.ts 调用外部 embedding / rerank 服务
  retriever.ts  稠密 + 稀疏 + RRF 融合 + 重排
  generator.ts  OpenAI 兼容的 LLM 调用
  ingest.ts     文档解析、切分、灌库
  embed_server.ts  纯 Node 的 embedding / rerank 服务（ONNX Runtime）
db/          建表 SQL 与迁移脚本
scripts/     初始化与健康检查脚本
```

## 更多

- 接口文档：见 [`docs/API.md`](./docs/API.md)
- Docker 一键部署：见 [`docs/DEPLOY.md`](./docs/DEPLOY.md) 2.2 节
- 部署拓扑、依赖与排障：见 [`docs/DEPLOY.md`](./docs/DEPLOY.md)
- 检索链路图示：见 `docs/RAG项目部署拓扑与依赖.png`
