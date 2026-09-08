// src/embed_server.ts
//
// 纯 Node 的 embedding / rerank 服务，替代原来的 Python（sentence-transformers）实现。
// 底层用 @huggingface/transformers（ONNX Runtime），直接加载 BGE-M3 / bge-reranker 的 ONNX 权重，
// 不再依赖任何 Python 环境。对外接口与旧版一致，因此 src/embeddings.ts 无需改动。
//
// 启动：npm run embed-server   （默认监听 :8001）
// 端口/模型/量化档位均可通过环境变量覆盖（见文件底部 DEFAULTS）。

import Fastify from 'fastify';
import {
  pipeline,
  env as tfEnv,
  AutoTokenizer,
  AutoModelForSequenceClassification,
  type FeatureExtractionPipeline,
} from '@huggingface/transformers';

// ---------------------------------------------------------------------------
// 配置（全部可被环境变量覆盖）
// ---------------------------------------------------------------------------
const EMBED_MODEL_ID = process.env.EMBED_MODEL_ID ?? 'Xenova/bge-m3';
const RERANK_MODEL_ID = process.env.RERANK_MODEL_ID ?? 'onnx-community/bge-reranker-v2-m3-ONNX';
// 注意：dtype 必须在该模型仓库里真实存在对应文件 onnx/model_<dtype>.onnx。
// Xenova/bge-m3 与 onnx-community/bge-reranker-v2-m3-ONNX 都没有 q8 档位，
// 填 q8 会回退到 fp32，而 fp32 的权重放在外部数据文件 onnx/model.onnx_data（2.2 GB）里，
// 缺失时 ONNX Runtime 只报 "terminated"，很难排查。int8 是单文件自包含（约 570 MB），最稳。
const EMBED_DTYPE = (process.env.EMBED_DTYPE ?? 'int8') as any;
const RERANK_DTYPE = (process.env.RERANK_DTYPE ?? 'int8') as any;
const EMBED_DEVICE = process.env.EMBED_DEVICE || undefined; // 不传则库自动选 cpu
const RERANK_DEVICE = process.env.RERANK_DEVICE || undefined;
const EMBED_POOLING = process.env.EMBED_POOLING ?? 'cls';
const EMBED_NORMALIZE = (process.env.EMBED_NORMALIZE ?? 'true').toLowerCase() !== 'false';
const EMBED_MAX_LENGTH = Number(process.env.EMBED_MAX_LENGTH ?? 512);
const RERANK_MAX_LENGTH = Number(process.env.RERANK_MAX_LENGTH ?? 512);
const EMBED_SERVER_PORT = Number(process.env.EMBED_SERVER_PORT ?? 8001);
const EMBED_SERVER_HOST = process.env.EMBED_SERVER_HOST ?? '0.0.0.0';

// 本地模型目录：npm run download-models 会把权重下到 <MODELS_DIR>/<model_id>/
const MODELS_DIR = process.env.MODELS_DIR ?? './models';

// 国内网络可设置 HF_ENDPOINT=https://hf-mirror.com 走镜像下载权重
if (process.env.HF_ENDPOINT) {
  tfEnv.remoteHost = process.env.HF_ENDPOINT.replace(/\/$/, '') + '/';
}

// 优先读本地模型目录。权重已由 scripts/download-models.mjs 下好时完全离线启动，
// 不必再走境外 CDN（HuggingFace 的 Xet CDN 对分片请求返回 400，几百 MB 下不完）。
tfEnv.allowLocalModels = true;
tfEnv.localModelPath = MODELS_DIR;

// transformers.js 的 cacheDir 默认落在包目录内的 ./.cache（镜像里即
// /app/node_modules/@huggingface/transformers/.cache），既不读 HF_HOME，
// 也不会被 docker volume 持久化 —— 容器一重启几百 MB 权重就白下了。
// 这里显式对齐 HF_HOME，保证权重落在挂载的卷上。
if (process.env.HF_HOME) {
  tfEnv.cacheDir = process.env.HF_HOME;
}

// ---------------------------------------------------------------------------
// 模型加载（懒加载，只加载一次）
// ---------------------------------------------------------------------------
let embedPipePromise: Promise<FeatureExtractionPipeline> | null = null;
let rerankReadyPromise: Promise<{
  tokenizer: any;
  model: any;
}> | null = null;

async function getEmbedPipe(): Promise<FeatureExtractionPipeline> {
  if (!embedPipePromise) {
    embedPipePromise = pipeline('feature-extraction', EMBED_MODEL_ID, {
      dtype: EMBED_DTYPE,
      ...(EMBED_DEVICE ? { device: EMBED_DEVICE as any } : {}),
    } as any);
  }
  return embedPipePromise;
}

async function getReranker() {
  if (!rerankReadyPromise) {
    rerankReadyPromise = (async () => {
      const tokenizer = await AutoTokenizer.from_pretrained(RERANK_MODEL_ID);
      const model = await AutoModelForSequenceClassification.from_pretrained(RERANK_MODEL_ID, {
        dtype: RERANK_DTYPE,
        ...(RERANK_DEVICE ? { device: RERANK_DEVICE as any } : {}),
      } as any);
      return { tokenizer, model };
    })();
  }
  return rerankReadyPromise;
}

// ---------------------------------------------------------------------------
// 业务函数
// ---------------------------------------------------------------------------
async function embedTexts(texts: string[]): Promise<number[][]> {
  const pipe = await getEmbedPipe();
  const options: any = {
    pooling: EMBED_POOLING,
    normalize: EMBED_NORMALIZE,
    max_length: EMBED_MAX_LENGTH,
  };
  const output = await pipe(texts, options);
  return output.tolist() as number[][];
}

/**
 * 对 (query, passages) 逐对打分。
 * bge-reranker 输出形如 [n, 1] 的 logits，值越大越相关；
 * 若模型输出 [n, 2]（含负类），取最后一列（正类）作为分数。
 */
async function rerank(
  query: string,
  passages: string[],
): Promise<Array<{ index: number; score: number }>> {
  if (!passages.length) return [];
  const { tokenizer, model } = await getReranker();

  const inputs = await tokenizer(
    passages.map(() => query),
    {
      text_pair: passages,
      padding: true,
      truncation: true,
      max_length: RERANK_MAX_LENGTH,
    },
  );

  const { logits } = await model(inputs);
  const dims = logits.dims; // 例如 [n, 1] 或 [n, 2]
  const cols = dims.length === 2 ? dims[1] : 1;
  const data = logits.data as Float32Array | number[];

  const results = passages.map((_, i) => {
    const value = cols > 1 ? data[i * cols + (cols - 1)] : data[i];
    return { index: i, score: typeof value === 'number' ? value : Number(value) };
  });

  results.sort((a, b) => b.score - a.score);
  return results;
}

// ---------------------------------------------------------------------------
// HTTP 服务
// ---------------------------------------------------------------------------
const app = Fastify({ logger: false });

app.get('/health', async () => ({
  status: 'ok',
  embedding: EMBED_MODEL_ID,
  reranker: RERANK_MODEL_ID,
}));

interface EmbedBody {
  texts?: unknown;
  model?: string;
}
app.post('/embeddings', async (req, reply) => {
  const body = req.body as EmbedBody;
  if (!Array.isArray(body?.texts) || body.texts.some((t) => typeof t !== 'string')) {
    return reply.code(400).send({ error: '`texts` must be an array of strings' });
  }
  try {
    const embeddings = await embedTexts(body!.texts as string[]);
    return { embeddings };
  } catch (err) {
    req.log.error(err);
    return reply.code(500).send({ error: (err as Error).message });
  }
});

interface RerankBody {
  query?: unknown;
  passages?: unknown;
  top_k?: unknown;
}
app.post('/rerank', async (req, reply) => {
  const body = req.body as RerankBody;
  if (typeof body?.query !== 'string' || !Array.isArray(body?.passages) ||
      body.passages.some((p) => typeof p !== 'string')) {
    return reply.code(400).send({ error: '`query` must be a string and `passages` an array of strings' });
  }
  try {
    const topK = typeof body.top_k === 'number' ? body.top_k : undefined;
    const results = await rerank(body.query as string, body.passages as string[]);
    return { results: topK ? results.slice(0, topK) : results };
  } catch (err) {
    req.log.error(err);
    return reply.code(500).send({ error: (err as Error).message });
  }
});

app.listen({ port: EMBED_SERVER_PORT, host: EMBED_SERVER_HOST }, (err, address) => {
  if (err) {
    console.error(err);
    process.exit(1);
  }
  console.log(`[embed-server] listening on ${address}`);
  console.log(`[embed-server] models dir = ${MODELS_DIR} (本地权重优先，缺失才回退远程)`);
  console.log(`[embed-server] embedding=${EMBED_MODEL_ID} (dtype=${EMBED_DTYPE}${EMBED_DEVICE ? `, device=${EMBED_DEVICE}` : ''})`);
  console.log(`[embed-server] reranker=${RERANK_MODEL_ID} (dtype=${RERANK_DTYPE}${RERANK_DEVICE ? `, device=${RERANK_DEVICE}` : ''})`);
});
