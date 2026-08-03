# AGENTS.md — packages/

## Purpose

Shared libraries, domain logic, database layer, WhatsApp engine adapters, SDKs, and integration packages for MultiWA.

## Ownership

| Package | Path | Purpose |
|---------|------|---------|
| `core` | `packages/core/` | Domain entities, ports (interfaces), value objects, and use cases. Zero framework dependencies. |
| `database` | `packages/database/` | Prisma ORM client, schema, and repository implementations. |
| `engines` | `packages/engines/` | WhatsApp engine abstraction with pluggable adapters: Baileys, whatsapp-web.js, Mock. |
| `sdk` | `packages/sdk/` | Official TypeScript SDK for the MultiWA REST API. |
| `sdk-python` | `packages/sdk-python/` | Official Python SDK. |
| `sdk-php` | `packages/sdk-php/` | Official PHP SDK. |
| `n8n-nodes-multiwa` | `packages/n8n-nodes-multiwa/` | n8n integration nodes (action + trigger). |
| `chatwoot-bridge` | `packages/chatwoot-bridge/` | Chatwoot CRM integration bridge. |

## Local Contracts

- `core/` has no external dependencies; defines interfaces that adapters implement
- `database/` is the sole Prisma schema owner; all DB access goes through it
- `engines/` factory (`src/factory/engine-factory.ts`) selects adapter by profile type
- `engines/` normalizes provider presence into canonical chat/participant JIDs; only adapters with documented inbound presence events emit it. whatsapp-web.js currently supports outbound chat state only and must not fabricate inbound presence.
- `engines/` normalizes Baileys ephemeral/view-once wrappers before classifying inbound messages and exposes downloadable media to API consumers.
- SDKs must track the API spec in `docs/07-api-specification.md`
- All packages use TypeScript strict mode and are built with `tsc`

## Work Guidance

- Domain changes first go into `core/` (entities, ports, use-cases)
- New DB fields go into `database/prisma/schema.prisma`; run `pnpm --filter @multiwa/database db:generate` after
- New WhatsApp engines add an adapter in `engines/src/adapters/` implementing the engine interface
- SDK changes must be mirrored across TS, Python, and PHP when the API surface changes

## Verification

- `turbo lint --filter=@multiwa/core` (and similar per package)
- `turbo test --filter=@multiwa/core`
- `pnpm --filter @multiwa/engines test` for engine normalization utilities
- `turbo typecheck`
- Prisma: `pnpm --filter @multiwa/database db:validate`

## Child DOX Index

No child AGENTS.md files currently. Each package is self-contained with its own package.json and src structure.
