#!/bin/bash
# 依赖探测。pg_isready / redis-cli 在部分机器上不存在，缺失时回退到通用 TCP 探测。
set -u

probe_port() {
  node -e '
    const net = require("net");
    const host = process.argv[1];
    const port = Number(process.argv[2]);
    const socket = net.createConnection({ host, port });
    socket.setTimeout(2000);
    socket.on("connect", () => { socket.destroy(); process.exit(0); });
    socket.on("timeout", () => { socket.destroy(); process.exit(1); });
    socket.on("error", () => process.exit(1));
  ' "$1" "$2" > /dev/null 2>&1
}

report() {
  if [ "$2" = "0" ]; then
    echo "✅ $1: OK"
  else
    echo "❌ $1: FAIL"
  fi
}

# Database
if command -v pg_isready > /dev/null 2>&1; then
  pg_isready -h localhost -p 5432 -U rag > /dev/null 2>&1
  report "Database" "$?"
else
  probe_port localhost 5432
  report "Database (端口探测)" "$?"
fi

# Redis
if command -v redis-cli > /dev/null 2>&1; then
  [ "$(redis-cli -h localhost -p 6379 ping 2>/dev/null || true)" = "PONG" ]
  report "Redis" "$?"
else
  probe_port localhost 6379
  report "Redis (端口探测)" "$?"
fi

# API
curl -sf http://localhost:9000/health > /dev/null 2>&1
report "API (:9000)" "$?"

# Embedding service
curl -sf http://localhost:8001/health > /dev/null 2>&1
report "Embedding (:8001)" "$?"

echo ""
echo "📋 Health check complete."
