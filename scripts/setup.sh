#!/bin/bash
set -e

echo "📦 Installing dependencies..."
npm install

echo "🏗️  Compiling TypeScript..."
npx tsc --noEmit || true  # Just check types

echo "🚀 Starting services..."
docker compose up -d

echo "⏳ Waiting for database..."
sleep 10

echo "📊 Running migrations..."
npx ts-node db/migrate.ts

echo "✅ Setup complete!"
echo "Start embedding service: python embed_service.py"
echo "Start the server: npm run dev"
