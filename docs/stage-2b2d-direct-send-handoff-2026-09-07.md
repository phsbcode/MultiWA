# Batch 2B.2D: direct-send profile ownership

## Objective and stop point

Protect the seven direct-send routes below. Complete isolated acceptance,
commit/push and green CI, then stop before merge or deployment for Astra review.
Preserve and include this prepared handoff and its docs index change.

Planning baseline: main `99e97b282e23c645f592a8ffd7b2093233ab994c`.
Accepted live image: `multiwa-api:stage2b2c-d3bc725-overlay`,
`sha256:920bc9d3336b928a552b6a22aa28526874c74a8c2315f6f5c49b65d56de18026`.
Verify current state rather than assuming it still matches. Read applicable
AGENTS.md files, inspect git status, fetch main, preserve later work and create a
feature branch. Save sanitized source/deployment metadata outside the repository.
Never print resolved Compose environments, tokens or credential files.

## Exact runtime scope

All paths begin `/api/v1/messages`. Each route requires exactly:

```ts
@RequireTenant({ resource: 'profile', from: 'body', key: 'profileId' })
```

| Method/path | Controller and service handler | DTO |
| --- | --- | --- |
| POST `/image` | sendImage | SendImageDto |
| POST `/video` | sendVideo | SendVideoDto |
| POST `/audio` | sendAudio | SendAudioDto |
| POST `/document` | sendDocument | SendDocumentDto |
| POST `/location` | sendLocation | SendLocationDto |
| POST `/contact` | sendContact | SendContactDto |
| POST `/poll` | sendPoll | SendPollDto |

Preserve `@UseGuards(JwtOrApiKeyGuard, TenantGuard)`. Authenticate first, then
resolve body.profileId through profile -> workspace -> organization. Same-
organization profiles remain allowed. Missing/foreign profile records yield the
same generic 404; absent/empty profileId retains the guard's 400 behavior; missing
organization context remains denied. Missing/invalid credentials yield 401.
Forged organization/workspace/profile query parameters cannot override the body.

Authorization must finish before DTO validation, service execution, conversation
creation, message persistence or engine lookup. Existing authenticated API-key
permission semantics remain unchanged; this is ownership enforcement, not scope
enforcement. Do not introduce permissions or rotate integration keys.

These handlers already call queueMessage, which creates/updates local records
before calling an engine. A disconnected engine returning a pending result is
therefore NOT evidence that a denied request had no side effects.

Preserve DTOs, response status/body, phone/JID normalization, generated vCards,
media defaults, audio PTT and poll validation. Preserve media URL handling without
adding URL fetching, upload validation or storage changes. No service rewrite or
schema/dependency change is expected. Capture baseline successful contracts in
isolation before editing, including sent and disconnected/pending paths.

## Explicit exclusions

POST `/text` accepts optional quotedMessageId. It stays in the next slice with
`/reply` and `/reaction`, where message references must be checked against the
same sending profile. Do not mark text or these child-reference routes protected
in this batch. Merely checking two resources belong to the same organization is
not sufficient to establish that they belong to the same profile.

Also exclude scheduling, typing, provider read receipts, delete-for-everyone,
participants, bulk sending, uploads/static media, hooks, API-key lifecycle/scopes,
sockets, admin UI, Operations and Payment Monitor changes. Do not expand this
batch to every route that can send a message.

## Tests and inventory

Add routed Nest/Fastify tests using the real TenantGuard, real controller, service
spies and the production ValidationPipe configuration. Use a compiler/test setup
that preserves the necessary DTO metadata; do not infer production validation
from TypeScript annotations alone.

For every route, prove exact required metadata, denied service calls equal zero,
and successful calls invoke the correct service once with the expected DTO.
Include foreign/missing profiles and absent organization context. Spy on engine
lookup/send methods and relevant persistence calls to establish that rejection
cannot reach them. Exercise successful mapping/default behavior with inert
adapters and synthetic media only. Never invoke a real provider or download a
remote media URL.

Extend inventory mutation checks across all seven routes: decorator removal,
line/block comments, changed resource/from/key, optional true including quoted
optionality, computed values, spreads, duplicate/unsupported fields, and guard
removal/comments. Ensure mutations actually alter the intended source. Preserve
the strict tenant parser and every prior mutation test.

Expected inventory transition is exactly seven confirmed gaps to protected:
74 -> 81 protected, 150 -> 143 confirmed gaps, 236 total entries. Review all
regenerated changes; keep public and decision-required counts unchanged.

## Isolated HTTP acceptance

Use the candidate API against disposable PostgreSQL, Redis and tmpfs storage,
without live credentials, sessions, volumes or publicly exposed test endpoints.
Verify selected image identity and reused-container configuration before testing.
All test profiles must be disconnected or explicitly configured to use the
existing inert mock adapter. Never connect a Baileys or whatsapp-web-js test
profile. Ensure no automations or outbound hooks can deliver test events.

Create dedicated profiles A1/A2 in organization A and B1 in organization B after
the prior filter/order assertions, or otherwise isolate them from earlier tests.
Use supported types/directions and synthetic payloads. Do not weaken previous
assertions to accommodate fixture collisions.

For each of seven routes and both JWT/API-key credentials, cover:

1. Owned A1 and A2 succeed with the expected HTTP status and complete response
   contract. Prove a correct persisted outgoing message, its profile/conversation
   linkage, recipient, type and mapped content. Cover an existing conversation
   and a new recipient across successful cases.
2. Foreign and missing profile IDs return identical generic 404 bodies with valid
   payloads. Repeat foreign access with forged query/profile/organization fields
   and malformed message-specific content, proving ownership precedes validation.
3. Missing and empty body.profileId return 400. Arrays/objects must fail without
   reaching services or creating records. Missing credentials, invalid JWT and
   invalid API key return 401 for every route.
4. Immediately before/after every denied request, compare complete conversations
   and messages across BOTH synthetic organizations, including newly created
   rows, contents, metadata and timestamps. Compare audit/scheduled records too
   where the route could touch them. Counts alone are insufficient.
5. Authorized mock sends call only the intended inert engine. Disconnected owned
   profiles preserve the pending response and pending local record. Test no-engine
   and mock-connected cases without letting a fixture reconnect to WhatsApp.

Record actual per-route/per-credential request totals; do not use hardcoded report
counters as proof. Retain the 63-request message-access, 45-request detail,
88-request conversation-mutation and Batch 2B.1 read compatibility matrices.
Retain the four existing characterization gaps: public static media, read-key
hook creation, cross-organization hook visibility and inactive-owner API keys.
Explicitly record the excluded send/reference routes as remaining inventory work.

## Candidate, verification and closeout

Run focused suites, API typecheck/build, the full API suite with synthetic database
configuration, inventory tests, `pnpm run check:release` and isolated HTTP
acceptance. Record actual totals and opt-in skips.

Check disk headroom before building. Do not repeat a full build that cannot fit.
If dependencies/schema remain unchanged, a documented overlay on the accepted
Batch 2B.2C image is acceptable: copy freshly compiled API dist from a clean,
recorded source commit, verify all compiled JS hashes and schema, record parent
and candidate digests, and test the resulting image. Never retag latest or
recreate live services during implementation.

Document the exact reproducible command in `docs/stage-2b2d-results.md`:

```bash
cd /home/hermes/MultiWA
AUTHZ_TEST_IMAGE=multiwa-api:stage2b2d-COMMIT \
AUTHZ_EXPECTED_IMAGE_ID=sha256:DIGEST \
pnpm run test:authz-characterization:isolated
```

Replace placeholders with verified values and identify the mounted test-script
revision separately from runtime. Update API docs, authorization inventory summary,
Stage 2A backlog and applicable AGENTS.md. Include this handoff in the feature PR.
Commit/push, open a draft PR and check CI at its final head. GitHub Pages settings
are out of scope; its known publishing 404 is separate from application CI.

Perform Docker cleanup, preserving every container, volume, active image and
retained rollback/candidate image. Report removed artifacts, actual recovered
space, live container health and free disk space. No real WhatsApp sends, group
scans, attachment processing, review changes, payment submissions, Register writes,
credential changes or Drive-sharing changes are authorized for testing.

Finish with commits, candidate identity, tests/CI, exact rerun command, remaining
limitations and an Astra review prompt. Stop before merge/deployment. Live remains
on Batch 2B.2C.
