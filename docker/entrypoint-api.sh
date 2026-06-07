#!/bin/sh
# MultiWA API Entrypoint
# Runs database schema initialization then starts the API server

set -e

echo "🔧 [entrypoint] Running database schema initialization..."

# The prisma schema is at ../../packages/database/prisma/schema.prisma relative to /app/apps/api
PRISMA_SCHEMA="../../packages/database/prisma/schema.prisma"

if [ -f "$PRISMA_SCHEMA" ]; then
  echo "🔧 [entrypoint] Applying Prisma schema (db push)..."
  # Intentionally outside set -e: failure to push is non-fatal — the app may still work
  # if tables were created manually or via an external migration
  if npx prisma db push --schema="$PRISMA_SCHEMA" 2>&1; then
    echo "✅ [entrypoint] Database schema initialized successfully"
  else
    echo "⚠️ [entrypoint] Prisma db push failed (non-fatal, continuing)"
  fi
else
  echo "⚠️ [entrypoint] Prisma schema not found at $PRISMA_SCHEMA, skipping migration"
fi

echo "🚀 [entrypoint] Starting API server..."
exec node dist/main.js
