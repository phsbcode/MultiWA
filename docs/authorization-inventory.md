# Authorization inventory

This document summarizes the reviewed machine-readable inventory in
`scripts/authz-routes.inventory.json`. The inventory is characterization, not an
authorization claim. `confirmed-gap` means source inspection found authentication
without the required owner/parent check, or the isolated HTTP test demonstrated
the gap. Later Stage 2 work must reduce those entries through behavior and tests.

## Coverage

Reviewed baseline: `40e20046fb630b615e190f160424574f61178379`.

- 232 controller routes found in source.
- 231 routes in the public API snapshot.
- One Swagger-excluded controller route: `GET /api/v1`.
- Four supplementary entrypoints: static media, API docs and two `/ws` gateways.
- 236 total inventory entries.
- 74 entries have explicit protected evidence.
- Eight are intentional public endpoints.
- 150 have confirmed ownership/role gaps in source.
- Four need an ownership decision, including three legacy hook routes.

The high gap count is deliberate. A class-level authentication guard does not
prove that a supplied profile, conversation, group, message or organization ID
belongs to the caller.

## Status meanings

| Status | Meaning |
| --- | --- |
| `protected` | Current handler evidence meets the recorded target boundary. |
| `intentional-public` | Public access is expected for this health/auth/root route. |
| `confirmed-gap` | The expected ownership or role check is absent or failed synthetic characterization. |
| `decision-required` | A safe target cannot be assigned without an explicit compatibility/migration decision. |

Every controller record includes the handler, effective guards, accepted
principal types, resource selectors, implemented and target access categories,
side effect, proposed permission, source evidence and known DNT consumers.

## DNT integration routes

| Route group | Current result | Stage 2 requirement |
| --- | --- | --- |
| Profile status and DNT Operations profile routes | Organization-scoped; DNT flag requires exact boolean `true`. | Preserve response shapes and exact flag behavior. |
| Profile message list | Organization ownership enforced for JWT and API keys. | Preserve scan filters, ordering and response fields. |
| Profile media batch | Organization ownership enforced; every requested ID must belong to the selected profile or the request returns 404 without partial data. | Keep the 50-ID bound and request-order response behavior. |
| Conversation message reads, message detail and local deletion | Organization ownership enforced; message routes also require the message profile to match its conversation profile. | Preserve response shapes, chronological cursor behavior and local-only deletion. |
| Sender resolution | Organization ownership enforced and may persist recovered identity metadata. | Stage 2C must decide whether the DNT key receives a dedicated capability or `messages:write`. |
| Conversation list/message list/detail | Organization ownership enforced for profile list, conversation messages and detail. Detail accepts a strict 1–100 message limit and defaults to 50. | Preserve chronological behavior and existing response fields. |
| Conversation mutations | Read, archive, unarchive, mute, pin, clear-messages and delete verify conversation ownership before service execution. | Preserve current success bodies and service semantics. |
| Conversation search/context | Current controller verifies profile organization; service verifies child containment. | Retain both checks and add guard-level regression coverage. |
| Group list | Ordinary and DNT Operations routes enforce organization ownership; the DNT route retains its exact flag check. | Preserve provider response shape and exact DNT flag behavior. |
| Legacy hooks | Authenticated global registry with no owner/profile field. | Complete the explicit hook ownership migration in Stage 2D. |

Payment Monitor source confirms use of profile status, group list, conversation
list/messages/context, profile messages/media/sender resolution and legacy hooks.
DNT Operations uses only its restricted profile and group routes in this inventory.

## Non-controller entrypoints

- `/uploads/media/*` is registered directly by Fastify and is publicly readable.
  An isolated synthetic file returned 200 without credentials.
- `/api/docs` is intentionally public.
- `EventsGateway` authenticates the socket and verifies profile organization on
  room join.
- `RealtimeGateway` shares `/ws` but stores a supplied profile subscription
  without its own organization lookup. Stage 2B must test the combined namespace
  behavior before changing either gateway.

## Existing API keys

A read-only aggregate query found six live keys: one active-user key with empty
permissions and five active-user scoped keys. No wildcard or inactive-user keys
exist in the live database. No key names, prefixes, hashes or secrets were read
into this documentation.

The isolated test established current compatibility behavior:

- Empty and wildcard permission lists are accepted as ordinary authenticated keys.
- A `messages:read` key can currently register a legacy hook.
- A key remains accepted after its user becomes inactive.

Stage 2C must preserve the one existing empty-permission key until its owner and
purpose are identified. Ownership checks apply regardless of permission shape.

## Inventory maintenance

Run:

```bash
pnpm run check:authz-inventory
pnpm run check:authz-inventory:test
```

Use `pnpm run check:authz-inventory:update` only to regenerate a draft after route
changes. Review classifications and selector relationships before committing it.
The checker rejects missing, stale or duplicate routes, wrong source/handler
evidence, selector or guard drift, malformed classifications and undocumented
supplementary entrypoints.
