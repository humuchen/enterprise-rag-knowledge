# Enterprise RAG Knowledge Base

Production-ready RAG stack: Fastify + PostgreSQL/pgvactor + BGE-M3.

## Quick Start

```bash
# 1. Start PostgreSQL + Redis
docker compose up -d

# 2. Install dependencies
npm install

# 3. Run migrations
npx ts-node db/migrate.ts

# 4. Index documents (requires embedding service running)
npx ts-node src/ingest.ts --source ./data/

# 5. Start API
npm run dev   # or: npx ts-node src/index.ts
```

## Architecture

- **Fastify API** on port 9000
- **PostgreSQL + pgvector** for hybrid dense/sparse retrieval
- **Embedding service** (Python/FastAPI or vLLM) required at `EMBEDDING_ENDPOINT_URL`
- **Reranker service** at `RERANK_ENDPOINT_URL`
- **LLM backend** (vLLM, OpenAI-compatible) at `LLM_BASE_URL`

## Endpoints

- `POST /api/v1/chat` — RAG query (non-streaming)
- `POST /api/v1/chat/stream` — streaming chat via SSE
- `POST /api/v1/documents` — upload + index documents
- `GET /api/v1/documents/{id}` — get document metadata
- `DELETE /api/v1/documents/{id}` — delete document + chunks
- `GET /api/v1/admin/metrics` — observability metrics
- `GET /health` — health check

## Embedding Service Setup

Since TypeScript cannot load sentence-transformers directly, you need a Python embedding service:

```bash
pip install "fastapi[all]" sentence-transformers
```

Create `embed_service.py`:
```python
from fastapi import FastAPI
from sentence_transformers import SentenceTransformer, CrossEncoder
from pydantic import BaseModel
import torch

app = FastAPI()
model = SentenceTransformer("BAAI/bge-m3").to("cuda" if torch.cuda.is_available() else "cpu")
reranker = CrossEncoder("BAAI/bge-reranker-v2-m3").to("cuda" if torch.cuda.is_available() else "cpu")

class EmbedRequest(BaseModel):
    texts: list[str]
    model: str = "BAAI/bge-m3"

class RerankRequest(BaseModel):
    query: str
    passages: list[str]
    top_k: int = 10

@app.post("/embeddings")
async def embed(req: EmbedRequest):
    embeddings = model.encode(req.texts, convert_to_list=True).tolist()
    return {"embeddings": embeddings}

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

Run it:
```bash
python embed_service.py
```
