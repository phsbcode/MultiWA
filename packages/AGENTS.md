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
- `engines/` preserves the quoted provider message ID from Baileys context metadata so downstream consumers can distinguish replies from unrelated new messages.
- `engines/` exposes typed Baileys callbacks for message edits/deletions/reactions, bounded history replay, LID-to-phone mapping, participant receipts, and media availability updates. Replayed history must remain marked as historical so consumers can suppress live-message side effects.
- Engines may expose a read-only trusted provider-identity resolver; Baileys resolves persisted LID identities through its encrypted session mapping store before emitting incoming messages, bounds inbound participant fallback to the current group metadata, normalizes device-scoped phone JIDs, and sends every newly recovered mapping through the persistence callback. Never treat the LID digits themselves as a phone number.
- Modern Baileys `secretEncryptedMessage` edits use a bounded, memory-only raw-message cache for decryption. Never persist encrypted edit envelopes as customer messages or expose their key material.
- Baileys uses profile-scoped durable auth supplied through `EngineConfig.authStore`. Legacy credential files are read-only migration inputs; database failure stops the connection rather than silently creating new credentials. Deletions remain tombstoned so old files cannot resurrect keys.
- `allowPairing=false` requires a retained MD `creds.me` identity and required key material before constructing a socket. rc14 selects login by `creds.me`, not `creds.registered`; valid QR-linked auth with `registered=false` remains recoverable. Automatic recovery must not call `initAuthCreds`, import a missing legacy identity, write fresh auth, cache/emit QR material, or reset credentials. Unexpected QR stops the attempt.
- Use the pinned Baileys package's default protocol version, `markOnlineOnConnect=false`, and no full-history opt-in. Group metadata lookups are bounded, coalesced and invalidated on membership/group changes. QR material is delivered to the authorized UI, never rendered in server logs.
- Only the exact observed `Stream Errored (unknown)` plus status 503 and empty `stream:error` node with sole `code=503` attribute normalizes to the reserved `Provider Service Unavailable (503)` recovery reason. Conflicting tags, attributes, children, raw text tokens and hard-stop messages remain unverified or terminal; never infer retryability from an arbitrary numeric 503.
- Baileys logged-out/401 disconnects must be normalized as session invalidation so stale credentials are cleared and a fresh pairing QR can be generated; they must not enter the temporary transport auto-retry loop.
- Investigation mode preserves credential evidence for operator review instead of clearing it on logged-out rejection. Connection diagnostics allow only numeric status/provider codes, known node/conflict tags, and known timelock enforcement enums. Auth diagnostics include only the read/write operation and allowlisted storage failure code; never serialize raw errors, nodes, credential documents, or message content into these diagnostic entries.
- Baileys transport diagnostics emit one `whatsapp_transport_close` schema-versioned summary per observed socket generation and an observer-ready marker. Keep at most 12 lifecycle events, numeric monotonic order/timing, allowlisted error codes/syscalls, and actual RFC close code/frame flags. Unknown close reasons retain only byte length and a SHA-256 hash of at most 4096 bytes with the hashed length. No payloads or arbitrary error/reason strings are retained.
- Observe underlying socket error/end/close before `ws` consumes errors. Local teardown intent must precede transport termination; subsequent cleanup must not become the initiating intent. Remove owned listeners on close, replacement, or a 35-second terminal-observation deadline. Report missing/private-field observations as unavailable; WebSocket activity is not proof of Baileys keepalive success. Do not enable verbose protocol logging.
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
- Transport diagnostic tests cover the installed `ws` library on isolated loopback plus synthetic TLS errors, teardown ordering, reason sanitization, duplicate closes, bounded retention, and listener cleanup. Verify observer-ready/archive delivery after deployment without deliberately closing a live profile; any synthetic archive probe must be explicitly labelled.
- `turbo typecheck`
- Prisma: `pnpm --filter @multiwa/database db:validate`

## Child DOX Index

No child AGENTS.md files currently. Each package is self-contained with its own package.json and src structure.
