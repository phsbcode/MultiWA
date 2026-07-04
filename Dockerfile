# ============================================
# MultiWA — Single Dockerfile (All-in-One)
# Build: docker build -t multiwa .
# ============================================

# ── Stage 1: Install & Build ─────────────────
FROM node:20-slim AS builder

WORKDIR /app

# Install system deps (git for baileys, chromium build deps)
RUN apt-get update && apt-get install -y git && \
    npm install -g pnpm && \
    rm -rf /var/lib/apt/lists/*

# Copy workspace config first (cache layer)
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml turbo.json ./

# Copy all package.json files
COPY apps/api/package.json ./apps/api/
COPY apps/admin/package.json ./apps/admin/
COPY apps/worker/package.json ./apps/worker/
COPY packages/core/package.json ./packages/core/
COPY packages/database/package.json ./packages/database/
COPY packages/engines/package.json ./packages/engines/
COPY packages/sdk/package.json ./packages/sdk/

# Install all dependencies
RUN pnpm install --no-frozen-lockfile

# Copy prisma schema and generate
COPY packages/database/prisma ./packages/database/prisma
RUN cd packages/database && npx prisma generate

# Copy all source code
COPY . .

# Build workspace packages in dependency order. Do not ignore failures: the API
# runtime imports these package entrypoints by their package.json "main" fields.
RUN pnpm --filter @multiwa/database build && \
    test -f packages/database/dist/index.js && \
    pnpm --filter @multiwa/core build && \
    test -f packages/core/dist/index.js && \
    pnpm --filter @multiwa/engines build && \
    test -f packages/engines/dist/index.js

# Build API
RUN pnpm --filter @multiwa/api build && \
    test -f apps/api/dist/main.js && \
    echo "✅ API build OK"

# Build Admin Dashboard
ARG NEXT_PUBLIC_API_URL=http://127.0.0.1:3333
ENV NEXT_PUBLIC_API_URL=$NEXT_PUBLIC_API_URL
ARG INTERNAL_API_URL=http://api:3333
ENV INTERNAL_API_URL=$INTERNAL_API_URL
RUN pnpm --filter @multiwa/admin build


# ── Stage 2: API Runtime ─────────────────────
FROM node:20-slim AS api

WORKDIR /app

# Install Chromium for whatsapp-web.js + runtime deps
RUN apt-get update && apt-get install -y \
      chromium libnss3 libfreetype6 libharfbuzz0b \
      ca-certificates fonts-freefont-ttf libxshmfence1 libgbm1 \
      git --no-install-recommends && \
    npm install -g pnpm && \
    rm -rf /var/lib/apt/lists/*

# Copy workspace config
COPY --from=builder /app/package.json /app/pnpm-lock.yaml /app/pnpm-workspace.yaml ./
COPY --from=builder /app/apps/api/package.json ./apps/api/
COPY --from=builder /app/packages/core/package.json ./packages/core/
COPY --from=builder /app/packages/database/package.json ./packages/database/
COPY --from=builder /app/packages/engines/package.json ./packages/engines/
COPY --from=builder /app/packages/sdk/package.json ./packages/sdk/

# Install production deps only
RUN pnpm install --no-frozen-lockfile --prod

# Copy built artifacts
COPY --from=builder /app/apps/api/dist ./apps/api/dist
COPY --from=builder /app/packages/database ./packages/database
COPY --from=builder /app/packages/core ./packages/core
COPY --from=builder /app/packages/engines ./packages/engines

# Generate Prisma client
RUN npm install -g prisma@6.19.2 && cd packages/database && prisma generate

# Workspace symlinks
RUN rm -rf /app/node_modules/@multiwa && mkdir -p /app/node_modules/@multiwa && \
    ln -sf /app/packages/core /app/node_modules/@multiwa/core && \
    ln -sf /app/packages/engines /app/node_modules/@multiwa/engines && \
    ln -sf /app/packages/database /app/node_modules/@multiwa/database && \
    rm -rf /app/apps/api/node_modules/@multiwa && mkdir -p /app/apps/api/node_modules/@multiwa && \
    ln -sf /app/packages/core /app/apps/api/node_modules/@multiwa/core && \
    ln -sf /app/packages/engines /app/apps/api/node_modules/@multiwa/engines && \
    ln -sf /app/packages/database /app/apps/api/node_modules/@multiwa/database

# Prisma client symlinks
RUN mkdir -p /app/node_modules/@prisma /app/node_modules/.prisma \
      /app/apps/api/node_modules/@prisma /app/apps/api/node_modules/.prisma && \
    ln -sf /app/packages/database/node_modules/@prisma/client /app/node_modules/@prisma/client && \
    ln -sf /app/packages/database/node_modules/.prisma/client /app/node_modules/.prisma/client && \
    ln -sf /app/packages/database/node_modules/@prisma/client /app/apps/api/node_modules/@prisma/client && \
    ln -sf /app/packages/database/node_modules/.prisma/client /app/apps/api/node_modules/.prisma/client

# Copy entrypoint script
COPY docker/entrypoint-api.sh /app/entrypoint-api.sh
RUN chmod +x /app/entrypoint-api.sh

# Session storage
RUN mkdir -p /data/sessions

ENV NODE_ENV=production
ENV SESSIONS_PATH=/data/sessions
ENV PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium
ENV PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true

EXPOSE 3333

WORKDIR /app/apps/api
ENTRYPOINT ["/app/entrypoint-api.sh"]


# ── Stage 3: Admin Dashboard Runtime ─────────
FROM node:20-alpine AS admin

WORKDIR /app

ENV NODE_ENV=production
ENV HOSTNAME="0.0.0.0"
ENV PORT=3001

# Install sharp for Next.js image optimization in standalone mode
RUN npm install sharp

COPY --from=builder /app/apps/admin/.next/standalone ./
COPY --from=builder /app/apps/admin/.next/static ./apps/admin/.next/static
COPY --from=builder /app/apps/admin/public ./apps/admin/public

EXPOSE 3001

WORKDIR /app/apps/admin
CMD ["node", "server.js"]
