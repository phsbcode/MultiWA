# AGENTS.md — docker/

## Purpose

Containerization configuration: Dockerfiles, Docker Compose files, Caddy reverse proxy, and Nginx configs for MultiWA deployment.

## Ownership

- `Dockerfile.admin` — Admin dashboard container image
- `Dockerfile.api` — API server container image
- `Dockerfile.worker` — Worker container image
- `Dockerfile.api-runtime-update` — a dependency-preserving update from an explicitly pinned existing API image, copying only prebuilt API/engine output from a minimal temporary context. Use only when dependencies/schema are unchanged; start Node directly without schema push. Retain the old container and image for rollback.
- `entrypoint-api.sh` — API container entrypoint
- `Caddyfile` — Caddy reverse proxy config
- `nginx/` — Nginx configs (main conf + example + landing page)

Also owns root-level:
- `Dockerfile` — Multi-stage build (builder -> api, admin)
- `docker-compose.yml` — Main Compose file (postgres, redis, api, admin)
- `docker-compose.dev.yml` — Dev overrides
- `docker-compose.production.yml` — Production overrides

## Local Contracts

- Root `Dockerfile` builds `api` and `admin` targets from the monorepo
- Dockerfiles install the repository-declared `pnpm@9.15.0`; unpinned package-manager installs can break reproducible CI builds.
- Docker Compose uses environment variables from `.env.docker` or `.env`
- The API host port is bound to `127.0.0.1`; public access must pass through the HTTPS reverse proxy
- Caddy handles TLS and reverse proxy in production
- Minio and Nginx are optional services

## Work Guidance

- New services in Compose should be added to all three Compose files as appropriate
- Dockerfile changes should maintain multi-stage caching for fast rebuilds

## Verification

- `docker compose build` succeeds
- `docker compose up` starts all services

## Child DOX Index

No child AGENTS.md files.
