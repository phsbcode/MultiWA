# AGENTS.md — apps/

## Purpose

Application layer of MultiWA: the NestJS REST API gateway, the Next.js admin dashboard, and the BullMQ background worker.

## Ownership

- `apps/api/` — NestJS with Fastify adapter: REST endpoints, WebSocket (Socket.IO), Swagger docs, all backend modules (accounts, auth, profiles, messages, contacts, broadcast, automation, webhooks, integrations, etc.). Socket.IO clients must authenticate with JWT or API key before connecting and may join only profile rooms owned by their organization. Conversation APIs own authorized, profile-scoped full-history message search and chronological message-context windows; the messages API also exposes a bounded, read-only resolver for trusted provider sender identities. Normalized presence is routed only through the matching profile room and resolved conversation. Native FastBots configuration is stored per profile in `Profile.settings.fastbots`; replies must use the inbound profile ID.
- `apps/admin/` — Next.js 14 App Router: admin dashboard UI, authentication pages, automation flow builder (React Flow), analytics, settings. The Chat page owns WhatsApp-style conversation interactions, including explicit URL-selected read-only sessions whose real component tests enforce a zero-mutation boundary, bounded conversation rendering for large accounts with flattened semantic conversation buttons, profile-scoped new-chat/contact selection with canonical `@s.whatsapp.net` drafts, validated attachment previews and captions, connection visibility, profile/conversation-safe presence with transient expiry, failed-text retry, jump-to-latest state, cursor-paginated history, stale-safe full-history message search whose context view preserves live timeline updates, sender-aware consecutive-message grouping and bubble tails, quoted-message replies, reactions, copying, composer-scoped send shortcuts, keyboard message navigation/shortcuts, and touch-safe long-press actions. The Integrations page owns the per-profile FastBots enable/disable control and Bot API key form.
- `apps/worker/` — BullMQ consumer: message processing, webhook delivery, automation execution, scheduled tasks

## Local Contracts

- All apps use TypeScript strict mode
- API depends on `@multiwa/core`, `@multiwa/database`, `@multiwa/engines`
- Admin communicates with API via REST + WebSocket (Socket.IO client)
- Browser Socket.IO uses the page origin through the public reverse proxy by default; explicit non-local API URLs and direct local-development URLs remain supported.
- Worker consumes BullMQ queues enqueued by the API
- Profile engine selection is persisted in `Profile.settings.engine`; profiles without a valid saved engine remain on `whatsapp-web-js`, while the engine manager constructs explicitly selected adapters through `EngineFactory` and restores profiles whose persisted state was `connected` or `connecting` before startup. Deliberately disconnected profiles remain disconnected.
- DNT Operations may discover or manage only profiles whose `Profile.settings.dntOperationsAccess` value is the exact boolean `true`. Its dedicated organization-scoped endpoints may list, connect, read a short-lived QR code, cancel pending pairing, permanently delete an explicitly allowed profile, or read groups; disabling the flag never disconnects the profile. QR cache entries expire server-side after two minutes.
- Profile message reads accept an optional validated `since` timestamp so bounded consumers can filter large media histories in PostgreSQL before response serialization. Bounded scanners may request `includeMedia=false` to receive media fingerprints and byte sizes without encoded payloads, then retrieve full payloads for no more than 50 profile-scoped message IDs through the dedicated media endpoint.
- WhatsApp protocol/status events such as `e2e_notification` are not customer messages. The API must discard them before conversation persistence, unread counts, notifications, hooks, automations, or FastBots AI processing.
- Provider message mutations update the existing persisted message and publish `message:update` to the profile room. Baileys history/append replays are persistence-only: they must be deduplicated and must not increase unread counts or invoke WebSockets, notifications, hooks, automations, or FastBots.
- Live incoming messages emit `message.received` hooks and persisted message edits emit `message.edited` hooks. Secret-backed hooks keep the HMAC-SHA256 proof in `X-Webhook-Signature` over the exact raw body. A hook may explicitly request `signatureInBody` for receivers such as Apps Script that cannot read custom headers; this opt-in adds the same proof to JSON without changing existing webhook bodies. Delivery timeout is also per hook, with the existing 10-second default preserved.
- Incoming replies persist their quoted provider message ID. A history replay may backfill a previously missing quote link on the existing message, but must not recreate the message or trigger live side effects.
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
