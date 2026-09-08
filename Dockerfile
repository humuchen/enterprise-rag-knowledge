# ---------- Builder stage (Alpine: fast npm install + tsc) ----------
FROM node:22-alpine AS builder
# Note: onnxruntime-node native binaries are NOT loaded at build time,
# only at runtime in the embed-server.  Alpine is fast & has small layers.

WORKDIR /app

# Install only production deps first (better layer caching)
COPY package.json package-lock.json ./
# NPM_REGISTRY 可选：国内网络可传 https://registry.npmmirror.com 加速。
# 不传时用默认 registry，镜像保持可移植。
ARG NPM_REGISTRY=""
# --fetch-retries 应对链路抖动：onnxruntime-node 等大包常在下到一半被重置。
RUN npm ci --no-audit --no-fund \
    --fetch-retries=10 --fetch-retry-mintimeout=5000 --fetch-retry-maxtimeout=120000 \
    --fetch-timeout=600000 \
    ${NPM_REGISTRY:+--registry=$NPM_REGISTRY}

RUN npm ci --no-audit --no-fund

# Full source copy + build
COPY tsconfig.json ./
COPY src/ ./src/
COPY db/ ./db/
# Copy db scripts into dist/db so compiled migrate.js finds init.sql at runtime
RUN npm run build && cp db/init.sql dist/db/init.sql

# ---------- Runtime stage (Debian bookworm-slim: glibc for onnxruntime-node) ----------
FROM node:22-bookworm-slim AS runtime
# onnxruntime-node bundles prebuilt glibc binaries; glibc is required
# at runtime when running embed_server.ts (BGE-M3 ONNX inference).

WORKDIR /app

# HF model cache lives inside the container; mount a volume to persist it
ENV NODE_ENV=production \
    HF_HOME=/app/.cache/huggingface \
    HF_HUB_DISABLE_TELEMETRY=1 \
    npm_config_cache=/tmp/.npm-cache

# Copy production deps (from Alpine builder — pure JS, arch-independent)
COPY --from=builder /app/node_modules/ ./node_modules/
# Copy compiled output + db scripts
COPY --from=builder /app/dist/ ./dist/
COPY --from=builder /app/db/ ./db/
COPY package.json ./
# Create writable runtime dirs (data may be bind-mounted by the user)
# Prefer local weights: `npm run download-models` populates ./models, which is
# bind-mounted at runtime.  Keep the HF cache writable for remote fallback.
RUN mkdir -p /app/.cache/huggingface /app/models /app/data /app/logs && \
    chmod -R 777 /app/.cache /app/models /app/data /app/logs
    
# RUN mkdir -p /app/.cache/huggingface /app/data /app/logs && \
#     chmod -R 777 /app/.cache /app/data /app/logs

EXPOSE 9000 8001

# Default: API server.  Override at runtime to run the embed-server instead:
#   docker compose up embed-server   →  CMD ["node", "dist/src/embed_server.js"]
CMD ["node", "dist/src/index.js"]
