# AGENTS.md — apps/

## Purpose

Application layer of MultiWA: the NestJS REST API gateway, the Next.js admin dashboard, and the BullMQ background worker.

## Ownership

- `apps/api/` — NestJS with Fastify adapter: REST endpoints, WebSocket (Socket.IO), Swagger docs, all backend modules (accounts, auth, profiles, messages, contacts, broadcast, automation, webhooks, integrations, etc.). Native FastBots configuration is stored per profile in `Profile.settings.fastbots`; replies must use the inbound profile ID.
- `apps/admin/` — Next.js 14 App Router: admin dashboard UI, authentication pages, automation flow builder (React Flow), analytics, settings. The Integrations page owns the per-profile FastBots enable/disable control and Bot API key form.
- `apps/worker/` — BullMQ consumer: message processing, webhook delivery, automation execution, scheduled tasks

## Local Contracts

- All apps use TypeScript strict mode
- API depends on `@multiwa/core`, `@multiwa/database`, `@multiwa/engines`
- Admin communicates with API via REST + WebSocket (Socket.IO client)
- Worker consumes BullMQ queues enqueued by the API
- Environment configuration via `.env` files (see root `.env.example`)

## Work Guidance

- New API modules should follow the existing NestJS module structure in `apps/api/src/modules/`
- API endpoints use `@UseGuards` with JWT or API key auth; RBAC via `@multiwa/api/src/modules/rbac/`
- Admin pages use the shadcn/ui component library; new components go in `apps/admin/src/components/ui/`
- Worker processors go in `apps/worker/src/processors/`

## Verification

- `turbo lint --filter=@multiwa/api` (and similar for admin, worker)
- `turbo test --filter=@multiwa/api` (Vitest)
- `turbo typecheck --filter=@multiwa/api`
- API snapshots: `scripts/check-api-contract.mjs`

## Child DOX Index

No child AGENTS.md files currently. Each app is single-purpose and its package.json + src structure provides sufficient guidance.
