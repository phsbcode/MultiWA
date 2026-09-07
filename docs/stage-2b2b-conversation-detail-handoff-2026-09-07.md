# Batch 2B.2B: conversation detail ownership

## Objective and stop point

Sol protects exactly `GET /api/v1/conversations/:id`, validates its optional
`messageLimit`, and produces a tested draft PR for Astra review. Do not merge,
deploy, or start later batches.

Verified planning baseline on 7 September 2026:

- Main: `4ee4fe6b6fc35bb4bdb1d6b7314a2a92a3039803`.
- Live Batch 2B.2A image: `multiwa-api:stage2b2a-494c0d8`.
- Live image ID: `sha256:faf91b6f31717dc0c8c73d11168c95623ec7e93e9eab58c19653e15240183bc4`.
- Live API was healthy. This image is the rollback baseline for the next release.

Fetch and verify current main, read applicable AGENTS.md files, inspect git status,
and preserve all concurrent work. Start a feature branch from verified main.
Record source refs and sanitized deployment metadata before editing. Keep secrets,
browser profiles, credentials and customer records outside the repository.

## Runtime contract

The controller already has `@UseGuards(JwtOrApiKeyGuard, TenantGuard)`. Add exactly:

```ts
@RequireTenant({ resource: 'conversation', from: 'param', key: 'id' })
```

Apply it to `ConversationsController.findOne`. Keep authentication first. Ownership
follows conversation, profile, workspace and authenticated organization. Query/body
profile or organization values and WhatsApp JIDs never grant access.

- JWT and existing API keys may read conversations under any profile in their own
  organization, including the second profile used by acceptance fixtures.
- Missing and foreign IDs return the same generic 404 before service execution.
- Missing/invalid credentials return 401. Missing principal organization remains
  denied by the existing guard.
- Preserve the successful conversation object, contact object or null, messages
  array and existing fields. Do not replace it with a list envelope or redact fields
  as part of this batch.
- Preserve selection of the newest N messages and their chronological return order.
  Do not change tie ordering or pagination on other endpoints.
- Reads must not change conversation/message records or invoke a WhatsApp provider.

## Message limit

Use a route-specific DTO or pipe. Do not change global validation settings.

- Omitted `messageLimit`: numeric 50.
- Explicit value: one decimal integer from 1 through 100 inclusive.
- Reject empty/whitespace-only, zero, negative, fractional, nonnumeric, nonfinite,
  repeated query values/arrays, and values over 100 with 400. Reject hexadecimal
  and exponent notation rather than accepting Number coercion silently.
- Numeric query strings must become numbers before reaching Prisma.
- Authentication and tenant guards run before parameter validation. Foreign/missing
  conversations with invalid limits still receive the same 404; unauthenticated
  requests still receive 401.

The maximum 100 is an intentional new bound aligned with existing history queries.
Inspect repository consumers first and document their limits. If an existing
consumer requires more than 100, report that concrete conflict instead of silently
breaking it or expanding this batch. Do not inspect private message contents.

Earlier characterization recorded a Prisma error for an omitted limit. Reproduce
the current omitted and explicit cases in isolation before attributing a cause;
the source currently declares a default of 50. Preserve the historical observation
but correct current documentation according to actual evidence.

## Expected files

- `apps/api/src/modules/conversations/conversations.controller.ts` and its specs.
- A small DTO/pipe under the conversation module, with focused validation tests.
- Conversation service/spec only if needed to implement or prove this contract.
- `scripts/authz-characterization.mjs`.
- `scripts/check-authz-inventory.test.mjs` and `scripts/authz-routes.inventory.json`.
- `docs/07-api-specification.md`, `docs/authorization-inventory.md`,
  `docs/stage-2a-results.md`, new `docs/stage-2b2b-results.md`, and owning AGENTS.md.

Prefer the existing guard and service. No schema migration or dependency upgrade
is expected. Avoid reformatting unrelated code.

## Acceptance

Use isolated synthetic organizations A and B, A1/A2 profiles in A, and B1 in B.
Use fresh conversations with distinguishable contacts/messages. Seed at least
101 messages at unique timestamps in the selected conversation, plus neighbors.

For both JWT and API-key authentication prove:

1. Owned detail succeeds for A1 and A2; contact-present, contact-null and empty
   conversation responses preserve the existing shape.
2. Omitted limit returns exactly the newest 50 messages, in chronological order.
   Limits 1, 2 and 100 return exactly the expected IDs. Compare complete expected
   response fields using synthetic data, not just HTTP status.
3. Every invalid limit class above returns 400 on an owned conversation. Duplicate
   query parameters must be tested through real HTTP, not only a DTO unit test.
4. Foreign and nonexistent IDs return identical non-disclosing 404 bodies. Repeat
   with invalid limits and forged profile/organization selectors.
5. Missing credentials, invalid JWT and invalid API key return 401.
6. Snapshot complete conversation/message rows from both organizations immediately
   before and after every denied request. Include content and metadata, not only
   IDs/status. Successful detail reads must also leave those records unchanged.
   Exclude API-key lastUsedAt bookkeeping explicitly from business-write counts.

Add routed Nest/Fastify tests with service spies for this actual controller route.
Denied requests must not invoke the service; a successful control request must
invoke `findOne` once with the authorized ID and normalized numeric limit. Include
the production validation pipe configuration in the test fixture. Keep the actual
TenantGuard implementation. A guard-only call followed by an unused service-spy
assertion is insufficient. Vitest lacks emitted constructor metadata here; use the
existing routed test wiring or explicit test injection without changing runtime DI.

Extend inventory mutations to the new route: decorator removal, line/block
comments, resource/from/key changes, optional true including quoted optionality,
computed values, spreads, duplicate/unsupported fields and guard removal/comments.
All must fail against the unchanged reviewed inventory. Keep prior mutation tests.

Exactly one inventory entry should move from confirmed-gap to protected: protected
70 to 71 and gaps 154 to 153 if no concurrent baseline change occurred. Keep 236
total entries and the public route snapshot unchanged. Investigate unexpected drift.

Replace the previous foreign-detail 200 characterization assertion with its new
404 assertion. Remove only that known-gap entry; the standard isolated run must
retain four explicit gaps: public static media, read-key hook creation,
cross-organization hook visibility, and inactive-user API keys. Preserve every
Batch 2B.1 assertion and the complete 88-request Batch 2B.2A mutation matrix.

## Verification and candidate evidence

Run focused tests, API typecheck/build, the full API suite, inventory checks and
`pnpm run check:release`. Generate Prisma locally if needed; use only an isolated
database URL. Document any opt-in skipped tests accurately.

Build a newly tagged API candidate from a clean recorded code commit. Do not retag
latest or reuse the live image for new runtime acceptance. Check disk space first;
the host has limited free space. Record the build command, commit, image ID, schema
hash and warnings. Verify compiled controller/DTO behavior belongs to that commit.

Run the existing isolated acceptance runner with actual candidate values:

```bash
cd /home/hermes/MultiWA
AUTHZ_TEST_IMAGE=multiwa-api:stage2b2b-COMMIT \
AUTHZ_EXPECTED_IMAGE_ID=sha256:DIGEST \
pnpm run test:authz-characterization:isolated
```

The uppercase values are placeholders. Validate reused containers' image, tmpfs,
mounts and synthetic environment before running. Never attach live credentials,
volumes or WhatsApp sessions. The runner mounts the checkout's characterization
script, so record both the tested image revision and test-script revision.

Commit/push scoped changes, open a draft PR, and check CI for its final head. The
known GitHub Pages publishing 404 is separate from application CI; do not enable
Pages, change site visibility or alter workflows in this batch.

After Docker work remove only unused build cache and disposable intermediate
images from the task. Preserve all containers, volumes, active images and retained
rollback/candidate images. Verify health and disk usage and report recovered space.

## Exclusions and final handoff

Do not change send/reply/reaction/scheduling, message deletion, group participants,
uploads/static media, hooks, key permissions/lifecycle, sockets, contact logic,
Operations or Payment Monitor. No live mutations, financial writes, scans, messages,
credential changes or Drive sharing changes are authorized. No live release yet.

`docs/stage-2b2b-results.md` must include exact revisions, per-scenario results,
test totals, isolated command with real image digest, four remaining gaps, the new
limit contract, rollback baseline and limitations. Guard-to-service ownership
reassignment races remain outside scope.

Finish with a concise Astra review prompt and confirmation that live remains on
Batch 2B.2A. Eventual release requires separate authorization and real staff `/exec`
queue/drawer/decoded-preview acceptance using the retained browser profile. Merely
leaving the loading state or returning evidence bytes is not visual acceptance.
