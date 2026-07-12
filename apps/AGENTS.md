# AGENTS.md — apps/

## Purpose

Application layer of MultiWA: the NestJS REST API gateway, the Next.js admin dashboard, and the BullMQ background worker.

## Ownership

- `apps/api/` — NestJS with Fastify adapter: REST endpoints, WebSocket (Socket.IO), Swagger docs, all backend modules (accounts, auth, profiles, messages, contacts, broadcast, automation, webhooks, integrations, etc.). Socket.IO clients must authenticate with JWT or API key before connecting and may join only profile rooms owned by their organization. Conversation APIs own authorized, profile-scoped full-history message search and chronological message-context windows; normalized presence is routed only through the matching profile room and resolved conversation. Native FastBots configuration is stored per profile in `Profile.settings.fastbots`; replies must use the inbound profile ID.
- `apps/admin/` — Next.js 14 App Router: admin dashboard UI, authentication pages, automation flow builder (React Flow), analytics, settings. The Chat page owns WhatsApp-style conversation interactions, including bounded conversation rendering for large accounts, profile-scoped new-chat/contact selection with canonical `@s.whatsapp.net` drafts, validated attachment previews and captions, connection visibility, profile/conversation-safe presence with transient expiry, failed-text retry, jump-to-latest state, cursor-paginated history, stale-safe full-history message search whose context view preserves live timeline updates, sender-aware consecutive-message grouping and bubble tails, quoted-message replies, reactions, copying, composer-scoped send shortcuts, keyboard message navigation/shortcuts, and touch-safe long-press actions. The Integrations page owns the per-profile FastBots enable/disable control and Bot API key form.
- `apps/worker/` — BullMQ consumer: message processing, webhook delivery, automation execution, scheduled tasks

## Local Contracts

- All apps use TypeScript strict mode
- API depends on `@multiwa/core`, `@multiwa/database`, `@multiwa/engines`
- Admin communicates with API via REST + WebSocket (Socket.IO client)
- Worker consumes BullMQ queues enqueued by the API
- WhatsApp protocol/status events such as `e2e_notification` are not customer messages. The API must discard them before conversation persistence, unread counts, notifications, hooks, automations, or FastBots AI processing.
- Route private text to FastBots only when it expresses actionable customer intent: a greeting, question, DNT/programme interest, or help request. Persist ordinary chat normally, but do not invoke AI for acknowledgements, closures, reactions, staff-style handoff text, or unrelated statements.
- Environment configuration via `.env` files (see root `.env.example`)

## Work Guidance

- New API modules should follow the existing NestJS module structure in `apps/api/src/modules/`
- API endpoints use `@UseGuards` with JWT or API key auth; RBAC via `@multiwa/api/src/modules/rbac/`
- Admin pages use the shadcn/ui component library; new components go in `apps/admin/src/components/ui/`
- Worker processors go in `apps/worker/src/processors/`

## Verification

- `turbo lint --filter=@multiwa/api` (and similar for admin, worker)
- `turbo test --filter=@multiwa/api` (Vitest)
- `pnpm --filter @multiwa/admin test` for admin pure UI/domain utilities
- `turbo typecheck --filter=@multiwa/api`
- API snapshots: `scripts/check-api-contract.mjs`

## Child DOX Index

No child AGENTS.md files currently. Each app is single-purpose and its package.json + src structure provides sufficient guidance.
