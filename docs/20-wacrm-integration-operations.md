# wacrm Integration Operations

This note documents the MultiWA-side behavior required by the wacrm integration.

## Current status

- MultiWA API is deployed from Docker Compose.
- wacrm uses MultiWA as a WhatsApp provider for outbound text and inbound message webhooks.
- The verified profile is `Dr Niki Millionaire Coach` with phone `601161059171`.
- The profile should reconnect automatically after API container restarts without requiring a new QR scan when the existing WhatsApp Web session remains valid.

## Reconnect behavior

The WhatsApp-Web.js adapter now clears stale Chromium profile lock files before starting a restored session:

- `SingletonLock`
- `SingletonCookie`
- `SingletonSocket`
- `DevToolsActivePort`

Why this matters:

- A Docker restart can leave Chromium lock files in the persisted session directory.
- When those locks remain, Chromium refuses to launch the existing profile.
- MultiWA then reports the profile as disconnected/connecting even though the WhatsApp session itself is still valid.

The adapter also promotes a restored authenticated session to ready when `client.info` is available. This prevents API/UI state from remaining stuck at `connecting` if whatsapp-web.js delays or misses the `ready` event after session restore.

## Inbound webhook sender fields

For group messages, the group chat JID is not the contact phone number. Webhook consumers need the actual participant JID.

The Baileys adapter includes these fields on inbound messages when available:

- `author`
- `participant`
- `pushName`

Consumers should prefer `participant`/`author` over `senderJid`/`from` when mapping a group message to an individual contact.

## Expected reconnect log sequence

After `docker compose up -d api`, a healthy restored profile should show logs similar to:

```text
Auto-reconnecting profile: Dr Niki Millionaire Coach
Connecting profile: <profile-id>
Authenticated for profile <profile-id>
Client ready for profile <profile-id>
Profile <profile-id> connected: 601161059171 (Dr Niki Millionaire Coach)
```

The first API response may still say `Scan QR code to connect` while the browser session is starting. Treat the later `Authenticated`, `Client ready`, and database `connected` status as the final state.

## Verification commands

From the MultiWA repo:

```bash
pnpm --filter @multiwa/engines build
pnpm --filter @multiwa/api build
sg docker -c 'cd /home/hermes/MultiWA && docker compose build api && docker compose up -d api'
sg docker -c 'cd /home/hermes/MultiWA && docker compose logs --tail=220 api | grep -E "Auto-reconnect|Connecting profile|Authenticated|Client ready|Profile .* connected|Engine connect|disconnected|error|QR|timed out"'
sg docker -c 'docker exec multiwa-postgres psql -U multiwa -d multiwa -c "select id, \"displayName\", \"phoneNumber\", status, \"lastConnectedAt\", \"updatedAt\" from profiles;"'
```

Expected database state:

```text
Dr Niki Millionaire Coach | 601161059171 | connected
```

## Related commits

- `8636989 fix: harden WhatsApp reconnect handling`
