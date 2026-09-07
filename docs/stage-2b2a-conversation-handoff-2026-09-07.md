# Batch 2B.2A: conversation mutation ownership

## Objective and baseline

Sol implements organization ownership checks on exactly seven existing conversation
mutation routes. Completion means a tested candidate ready for Astra review, not a
live release. This document does not authorize implementation of later batches.

Verified on 7 September 2026:

- GitHub main merge baseline: `1cf4360a9c8aab0b6b8d452429483505036d4ce9`.
- Local branch: `agent/baileys-message-events`, HEAD `aa4ef26`, clean when inspected.
- Live accepted Batch 2B.1 image:
  `sha256:a332d5526e08bae77337ba7112fde5409fb8f2153fef3de9f954f04918afdda1`.
- The older Stage 1 image is historical rollback, not the baseline for this batch.
- `docs/stage-2b1-results.md` still says Stage 1 is live. That statement is obsolete;
  verify live image identity independently before beginning.

Fetch and inspect before work. Start a feature branch or isolated worktree from
verified main; preserve all later or uncommitted changes. Record source refs, live
image and deployment metadata privately before editing. Never export credentials,
session files or production data into the test environment.

## Exact route scope

All paths below start with `/api/v1/conversations`.

| Method and suffix | Handler | Existing successful response |
| --- | --- | --- |
| PUT `/:id/read` | `markAsRead` | `{success: true}` |
| PUT `/:id/archive` | `archive` | `{success: true}` |
| PUT `/:id/unarchive` | `unarchive` | `{success: true}` |
| PUT `/:id/mute` | `toggleMute` | `{success: true, isMuted}` |
| PUT `/:id/pin` | `togglePin` | `{success: true, isPinned}` |
| DELETE `/:id/messages` | `clearMessages` | `{success: true}` |
| DELETE `/:id` | `delete` | `{success: true}` |

The controller already declares `@UseGuards(JwtOrApiKeyGuard, TenantGuard)`.
Each route must declare this exact metadata:

```ts
@RequireTenant({ resource: 'conversation', from: 'param', key: 'id' })
```

Keep authentication before ownership. Ownership follows conversation → profile →
workspace → organization, using the authenticated principal's organization. A
WhatsApp JID, query `profileId`, or supplied organization ID is never authority.
No new required request fields or scope semantics are introduced.

Both valid JWT and existing API-key callers retain access to conversations in
their own organization, including another profile in that organization. Missing
or foreign conversation IDs must return the same generic 404 before service
execution. Missing/invalid credentials remain 401. A principal without organization
context remains denied by the existing guard.

## Implementation boundaries

Primary files:

- `apps/api/src/modules/conversations/conversations.controller.ts`
- its existing controller/service specs and `common/tenant/tenant.guard.spec.ts`
- `scripts/authz-characterization.mjs`
- `scripts/check-authz-inventory.test.mjs`
- `scripts/authz-routes.inventory.json`
- `docs/07-api-specification.md`, `docs/authorization-inventory.md`,
  `docs/stage-2a-results.md`, and nearest applicable AGENTS.md

Prefer route decorators and tests. Do not rewrite TenantGuard or the services
unless a failing requirement demonstrates the need. Keep body, status and field
contracts unchanged for successful calls. No database migration is expected.

Known service behavior to document, not silently change in this batch:

- Archive/unarchive currently replace metadata with `{archived: boolean}`.
- Mark-read currently updates all non-read messages in the conversation.
- Clear/delete use multiple database operations rather than one transaction.
- Mute/pin are toggles, not idempotent setters. Never automatically retry them.

These are separate semantic/atomicity concerns. Unauthorized requests must never
reach any of these operations. Do not claim the decorator prevents ownership
changes racing between the guard and service; profile/workspace reassignment
concurrency remains outside this bounded change.

## Required acceptance evidence

Use two synthetic organizations, at least two profiles in organization A and one
in B, and separate conversations/messages for each mutation scenario. No real
WhatsApp sessions, live credentials or provider connections. Snapshot the relevant
isolated records before and after each denied request.

For every route, test:

1. Missing credentials and invalid credentials return 401 with zero writes.
2. JWT and API key each succeed on an owned conversation. Assert the exact HTTP
   response and intended database change, not only status 200.
3. JWT and API key each receive 404 for a foreign conversation and a nonexistent
   conversation. Assert matching non-disclosing error bodies and zero changes to
   both organizations' conversation/message records.
4. A forged query/body profile or organization selector cannot grant foreign access.
5. An owned conversation in A's second profile remains accessible. Authorization
   is organization-wide; do not invent a profile allowlist.

For read, assert unread count/message changes stay inside the selected conversation.
For mute/pin, test true then false using explicit separate user actions. For clear,
assert only the selected conversation's messages disappear and its counters reset.
For delete, assert that conversation and its messages disappear while neighboring
conversations/messages remain. Use fresh fixtures so an earlier delete cannot
turn a foreign-ownership test into a mere missing-record test.

Add service spies in routed guard/controller tests to prove forbidden requests do
not invoke the service. The real HTTP tests provide the complementary database
evidence. Ignore authentication bookkeeping such as API-key lastUsedAt when counting
business writes, and state that distinction in the report.

Extend inventory mutations across all seven routes: decorator removal, line/block
commenting, resource/from/key changes, optional true including quoted property,
computed selector/optionality, spreads, duplicate/unsupported fields, and guard
removal/commenting. Confirm each fails without updating the inventory. Baseline
classification should move exactly seven routes from confirmed-gap to protected;
investigate any additional change rather than accepting a regenerated snapshot.

Keep every Batch 2B.1 HTTP assertion, including cursor ownership and media limits.
Do not reduce the five explicitly recorded later-stage gaps to make tests pass.

## Commands and candidate identity

Run API compilation, focused tests, the full API suite, inventory mutations and
`pnpm run check:release`. Build a candidate from a clean, recorded source revision.
Do not reuse the Batch 2B.1 image for new runtime acceptance or retag `latest`.
Verify the built files and Prisma schema match the intended candidate. Record
build commands, source revision, image digest and any build warnings.

Run the existing isolated runner with the NEW candidate values:

```bash
cd /home/hermes/MultiWA
AUTHZ_TEST_IMAGE=multiwa-api:stage2b2a-CANDIDATE_COMMIT \
AUTHZ_EXPECTED_IMAGE_ID=sha256:CANDIDATE_DIGEST \
pnpm run test:authz-characterization:isolated
```

The uppercase values are placeholders to replace with actual built identifiers.
The runner must print the selected digest, provision its isolated schema and use
temporary storage. Inspect existing test container configuration before reuse;
no live mounts, environment credentials or sessions may be attached. Preserve
containers and named volumes during required Docker cleanup.

## Deferred work and stop point

Excluded: send/reply/reaction, scheduled messages, bulk/broadcast, participant and
group provider operations, conversation detail GET, static media, uploads, hooks,
API-key scope enforcement, inactive-user keys, JWT revocation, and Operations or
Payments Monitor changes. These need separate handoffs. In particular, static
media needs a consumer inventory and authenticated or expiring-link design that
preserves original-slip previews before implementation.

Write `docs/stage-2b2a-results.md` with actual test totals, per-route matrix,
zero-denied-write evidence, candidate identity, exact reproduction command,
known limitations and rollback references. Commit/push the scoped correction and
obtain green CI through a review PR. Do not merge or deploy before Astra review
and explicit release authorization. No live mutation acceptance is authorized.

The eventual release uses accepted Batch 2B.1 as rollback and verifies existing
Payment Monitor reads and staff queue/drawer/preview without scans or submissions.
Do not begin the next sub-batch on completion.
