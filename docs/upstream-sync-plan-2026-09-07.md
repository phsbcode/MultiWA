# Selective upstream synchronization plan for Sol

Status: implementation handoff, not an instruction to deploy all stages at once.

## Baseline and scope

- Work repository: `/home/hermes/MultiWA`, origin `phsbcode/MultiWA`.
- Synchronized baseline: `9bd608e3af35c4f294db36aaacbebe3273bb5cc9`.
- Upstream reference: `ribato22/MultiWA`, pinned at
  `ff51e79dd83da6fd5dee71765dfaf0ea71ae0d24`.
- Common ancestor: `c991e93b430f219f1b2f824a2070f52096ce029e`.
- Port behavior and its regression tests into our architecture. Do not merge
  upstream main or copy whole controllers over DNT changes.
- Read the applicable AGENTS.md chain before edits. Use named helpers and small
  commits. Record upstream provenance and local adaptations in each commit.
- Root and dedicated Dockerfiles already pin pnpm 9.15.0. The media endpoint
  documentation and 231-route snapshot are synchronized. Do not repeat those fixes.
- The running API was built from `aec145d` plus the LID correction, excluding
  the logout-lifecycle edit. GitHub includes both. Before any release, compare
  the full candidate with the running image and list every additional change.

Sol implements each stage. Astra should review stages 2, 3 and 4 before release,
particularly authorization, token migration, retry semantics and profile isolation.
Do not claim an independent review unless it actually occurred.

## Contracts to preserve

- Explicitly allowed, organization-owned DNT Operations profiles and routes.
- Profile message `since`, `direction`, `type`, `includeMedia`, ordering and
  pagination behavior. Media retrieval accepts at most 50 profile-scoped IDs.
- `/messages/profile/:profileId/resolve-senders`, group discovery, original media,
  quoted provider IDs, edited text, and chronological context APIs.
- Baileys LID recovery, device-JID normalization, history replay isolation,
  protocol-message filtering, and the existing realtime chat controls.
- Legacy `/api/v1/hooks` registrations used by Payments Monitor, including
  `message.received`, `message.edited`, `signatureInBody` and per-hook timeout.
- Apps Script signature input is JSON serialization of ordered fields
  `{event,timestamp,data}`. The signature excludes the signature field itself.
- Payment Monitor and Operations remain separate. Do not bypass reviewer
  authorization, confirmation or payment idempotency.
- Testing must not submit payments, write Register, scan groups, send WhatsApp
  messages or change live reviews. Use synthetic fixtures and isolated services.

## Stage 1: prevent broad acknowledgement writes

Upstream references: `fb811d1`, `494fb34`, `4a68c52`.

Targets: API `modules/profiles/engine-manager.service.ts`, matching worker
handler if present, and a small shared acknowledgement helper where practical.

1. Validate the provider message ID as a nonempty string before any query.
2. Restrict acknowledgement updates to both `profileId` and `messageId`.
3. Validate status values and preserve the documented transition behavior.
4. Port narrowly bounded deadlock retries for recognized database errors only.
   Do not retry arbitrary exceptions or log provider identifiers.

Acceptance: missing/blank/malformed IDs perform zero writes; two profiles with
the same provider ID cannot affect each other; valid events update only their
target messages; retry exhaustion is observable. Verify real Prisma query
behavior against an isolated database, not just a mocked updateMany function.

Release separately. This is the smallest high-priority correction.

## Stage 2: organization ownership and API-key permissions

Upstream references: `54667f2`, `a96aaed`, `5917686`, `8c5c6fa`, `c320fff`,
`dcc05cd`, `c403bd2`. Consult pinned upstream `common/tenant/` and
`modules/auth/guards/api-key-scope.guard.ts`.

2A. Inventory every current route and the resource IDs accepted in path, query
and body. Document existing protection rather than assuming none. Start with
messages, media, sender resolution, conversations, profiles, groups and hooks;
then cover management and remaining profile-bound controllers before calling
organization isolation complete.

2B. Adapt ownership guards to our Prisma 6 schema. Guard order is authentication,
API-key capability check, then resource ownership. Verify every supplied child
resource belongs to the selected profile as well as the caller's organization.
Bulk media reads must not leak foreign IDs. Preserve public login and health
routes explicitly. Organization member changes also require the appropriate role.

2C. Carry scopes from the API-key strategy into the principal. Match scope names
to the admin UI, notably `messages:read` and `messages:write`. Establish existing
key semantics with sanitized counts before enforcement. Upstream treats empty
or wildcard scopes as full capability; preserve intentional legacy compatibility
without allowing missing organization ownership. Do not silently reinterpret
or rotate existing integration keys. JWT requests still require ownership checks.

2D. Treat the global legacy hook registry as a specific migration problem. Do not
delete it because upstream prefers `/webhooks`. Establish trusted ownership for
each existing registration without exposing secrets, or introduce a compatible
protected adapter. Never offer all organizations access to the global registry.

Acceptance: real HTTP tests with two synthetic organizations, JWTs, read-only,
write and legacy keys. No auth returns 401; foreign resources are denied without
disclosing data; read-only keys cannot mutate; cross-profile media and context
IDs are denied. Existing DNT reads pass with their intended credentials. Add a
route-coverage check so newly introduced endpoints cannot omit ownership metadata.

## Stage 3: session revocation and refresh-token recovery

Upstream references: `609fe3e`, `24f1704`, `36198d7`.
Targets: auth strategy/service, sessions service and Session schema if needed.

3A. Enforce persisted session validity on JWT requests. Confirm current login
paths create usable sessions before enabling the check. Throttle last-seen writes.

3B. Separate access-token and refresh-token verification using the configured
secrets. Implement persisted refresh-token rotation, revocation and reuse checks
without retaining plaintext refresh tokens. Define simultaneous-refresh behavior
so normal multi-tab usage does not accidentally revoke legitimate sessions.

3C. Document the effect on existing staff sessions. Prefer additive schema changes
and deploy compatible code first. If reauthentication is unavoidable, make that
part of the release notice; do not weaken validation to avoid the migration.
Preserve API-key integrations independently of JWT session changes.

Acceptance: login, refresh, logout, per-session revoke and revoke-all; expired,
reused and wrong-token-type requests denied; concurrent refresh policy tested;
database failure cannot grant access. Exercise schema upgrade and recovery on a
copy containing synthetic legacy-format sessions before any real rollout.

## Stage 4: durable delivery for the existing payment hooks

Upstream references: `afa36f3`, `292f56e`, `90be4fb`, `b249a4a`.
Targets: hooks dispatch, existing BullMQ integration and delivery processor.

4A. Preserve hook IDs, URLs, secrets and opt-in signature format. Add durable
delivery to the existing hook path through a narrow adapter. Do not switch the
live WhatsApp engine to a worker process as part of this change.

4B. Enqueue one delivery per hook/event with a stable ID, bounded retries/backoff,
timeout and failed-job retention. A process restart must not lose queued work.
If Redis is unavailable, surface the enqueue failure and provide durable recovery;
an in-memory promise or successful HTTP response alone is not durable acceptance.

4C. Verify application acknowledgement as well as HTTP status for the DNT receiver.
Apps Script can return HTTP 200 with a rejected-event JSON body. Do not generalize
the DNT response contract to arbitrary hooks. Distinguish retryable busy/transient
failures from signature/configuration errors and deliberate unselected-group skips.

4D. Resolve timestamp expiry before implementation: the receiver checks envelope
age. Choose either a retry horizon within that limit or fresh signed delivery
timestamps with stable event identity and the original occurrence time in data.
Test lost acknowledgements and replay explicitly. At-least-once delivery must
not create duplicate review work. Any receiver contract change is a separately
backed-up TEST change, reviewed together with the sender.

4E. Expose failed deliveries and queue backlog through an authenticated diagnostic
endpoint with sanitized metadata. Payment Monitor can report that health on
dashboard refresh. Preserve the user's refresh-only health-check preference.
Do not emit extra WhatsApp messages or silently trigger recovery scans for tests.

4F. Apply upstream outbound URL protection to webhook delivery, including redirects
and private-address destinations. Permit only the exact intended Google receiver
redirect behavior; do not forward secrets to arbitrary redirect hosts. Test this
using synthetic local receivers in an isolated environment.

Acceptance: initial 404 then success, persistent 401, timeout after receiver
acceptance, HTTP-200 rejection, Redis interruption, dispatcher restart, retry
expiry, edit versus original event identity, and duplicate delivery. Verify one
synthetic review outcome and no financial writes. Use the real frozen TEST
receiver only for a signed health probe unless a separate fixture is authorized.

## Stage 5: complete build reproducibility

Upstream references: `c71e5c0`, `473cf2d`, `6ed2bc7`.

The pnpm pin is done. Complete manifest coverage and frozen-lockfile installation
in each actual Docker path, accounting for this branch's packages rather than
copying upstream's newer workspace layout. Prevent source copies from overwriting
generated dependencies. Remove `|| true` build masking from dedicated Dockerfiles.
Preserve the working Chrome-for-Testing choice and existing entrypoints/ports.

Acceptance: API, worker and admin builds from a clean checkout; manifest drift
fails installation; TypeScript failure fails the image build; runtime starts with
the expected dependency versions. Do not bundle NestJS/Prisma/BullMQ major upgrades.

## Deferred work

Plan separately: NestJS 11/Fastify 5, Prisma 7, BullMQ 6, engine-host migration,
new outbound sending policies and broad admin changes. Review security patch
updates on their own merits, particularly Next.js, without assuming every latest
major is compatible. Upstream's Baileys identity method is a stub at the pinned
reference, so preserve our adapter implementation.

LID follow-up is also separate: verify persistent capture and propagation into
Payment Source Occurrences. Existing MultiWA message updates alone do not prove
that previously stored review sources refresh. Do not claim that end-to-end
repair is complete without a synthetic late-mapping test.

## Execution and release procedure

1. Inspect current git status and live image identity. Create a feature branch
   from the verified synchronized baseline; preserve concurrent edits.
2. Before each stage, record rollback source/image/config metadata privately.
   Never commit environment files, session stores, credentials or customer data.
3. Implement one stage or stated substage with its tests and documentation.
   Run `pnpm run check:release`, relevant tests/typechecks, and required CI gates.
   Test both package behavior and the real routed HTTP path where relevant.
4. Test with isolated PostgreSQL/Redis and synthetic profiles. Never mount live
   sessions into a second engine instance. Local node_modules was removed to save
   disk; use one reusable isolated test environment instead of repeated full builds.
5. Obtain the specified architecture review and fix findings before release.
   A request to implement one stage does not authorize all deferred migrations.
6. Release each accepted stage separately. Preserve an explicit working rollback
   image. Validate schema compatibility before promising an image-only rollback.
7. Verify authenticated MultiWA connection, selected group/message visibility,
   metadata/media read contracts and Payment Monitor signed health. Verify staff
   dashboard queue/drawer reads without triggering attachment triage or Scan Groups.
8. Clean disposable Docker layers and build cache, preserve containers/volumes and
   retained recovery images, verify health and disk use, then report recovered space.
9. Record exact source commit, image ID, configuration/schema changes, test totals,
   actual live checks, remaining limits and rollback commands. Distinguish code
   synchronized to GitHub from code actually running.

First implementation task for Sol: Stage 1 only, including isolated database
acceptance. Then proceed through the remaining stages as authorized.
