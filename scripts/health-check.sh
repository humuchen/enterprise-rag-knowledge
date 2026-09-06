#!/bin/bash
set -e

# Check DB
if pg_isready -h localhost -p 5432 -U rag > /dev/null 2>&1; then
  echo "✅ Database: OK"
else
  echo "❌ Database: FAIL"
fi

# Check Redis
if [ "$(redis-cli -h localhost -p 6379 ping 2>/dev/null || true)" = "PONG" ]; then
  echo "✅ Redis: OK"
else
  echo "❌ Redis: FAIL"
fi

# Check API
if curl -sf http://localhost:9000/health > /dev/null 2>&1; then
  echo "✅ API: OK"
else
  echo "❌ API: FAIL"
fi

# Check embedding endpoint
if curl -sf http://localhost:8001/health > /dev/null 2>&1; then
  echo "✅ Embedding: OK"
else
  echo "❌ Embedding: FAIL"
fi

echo ""
echo "📋 Health check complete."
