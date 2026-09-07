# Stage 2B.2D direct-send ownership

Runtime source commit: `5fb75499279c623c90147a0c78ac491d9dc0fa72`.
Characterization and inventory commit:
`9fcd5fe18be7edefa31f4c46ff6df73fc5b3fb6c`.

Candidate image: `multiwa-api:stage2b2d-5fb7549-overlay`, image ID
`sha256:f4b0a187e5cc6376a322abb861343f3ff9866677983a72469971449c87e6f26a`.
Its parent is the accepted live Batch 2B.2C image
`sha256:920bc9d3336b928a552b6a22aa28526874c74a8c2315f6f5c49b65d56de18026`.
Live remains on that parent. This candidate has not been merged or deployed.

## Change

Seven existing routes now require body profile organization ownership before DTO
validation or service execution:

- POST `/api/v1/messages/image`
- POST `/api/v1/messages/video`
- POST `/api/v1/messages/audio`
- POST `/api/v1/messages/document`
- POST `/api/v1/messages/location`
- POST `/api/v1/messages/contact`
- POST `/api/v1/messages/poll`

Each declares `@RequireTenant({ resource: 'profile', from: 'body', key:
'profileId' })` under the existing JWT-or-API-key and tenant guard order. Foreign
and missing records receive the same generic 404. Missing/empty selectors receive
400. Arrays, objects and numeric tenant selectors now receive 400 before an
ownership query. Route payloads and success responses remain unchanged.

Text, reply and reaction remain outside this batch because their message references
must be checked against the same sending profile. Scheduling, typing, receipts,
delete-for-everyone, uploads, hooks and API-key permission/lifecycle work also
remain separate.

## Acceptance

Before the runtime edit, the accepted Batch 2B.2C image completed 28 synthetic
success requests: every route through both JWT and API-key credentials on connected
A1 and disconnected A2 profiles. This recorded the existing sent and pending
contracts.

The candidate repeated those 28 successes and completed 91 denial requests, for a
119-request direct-send matrix. It verified:

- A1 mock sends returned 201/sent with the expected inert engine message type.
- A2 sends returned 201/pending without provider access.
- Every saved message retained the requested profile, its matching conversation,
  outgoing direction, mapped content/defaults and expected status. Tests covered
  existing and new conversations.
- Foreign/missing profiles returned matching 404 bodies for JWT and API keys.
  Forged query selectors and malformed message content did not bypass ownership.
- Missing, empty, array and object profile selectors returned 400. Missing or
  invalid JWT/API-key credentials returned 401 on every route.
- Before and after every denied request, the test compared complete profiles,
  conversations, messages, scheduled messages and audit rows for both synthetic
  organizations. Denied business writes were zero.

The mock adapter's acknowledgement callbacks are asynchronous. Characterization
waits for two identical full snapshots before denial checks, so legitimate mock
status changes cannot mask or falsely report a denied write. Failures report only
the operation label rather than dumping records.

The run retained Batch 2B.1 compatibility, the 45-request conversation-detail
matrix, 88-request conversation-mutation matrix and 63-request message-access
matrix. Four known gaps remain explicit: public static media, read-key hook
creation, cross-organization hook visibility and inactive-owner API keys.

## Verification

- Focused direct-send guard/controller/service suites: 61 passed.
- Full API suite: 239 passed; two opt-in integration tests skipped.
- API typecheck and production build: passed.
- Authorization inventory mutation suite: 17 passed.
- Inventory: 232 controller routes plus four supplementary entries; 81 protected,
  143 confirmed gaps, eight intentional public and four needing a decision.
  Exactly seven routes moved from confirmed gap to protected.
- Isolated HTTP characterization: passed using disposable PostgreSQL, Redis and
  tmpfs API storage without live credentials, sessions or volumes.

## Candidate construction

The host had about 3.1 GB free, below the prior full-build requirement. Dependencies,
entrypoint and Prisma schema are unchanged, so the candidate is a small runtime
overlay on the accepted Batch 2B.2C image:

```dockerfile
FROM multiwa-api:stage2b2c-d3bc725-overlay
COPY dist /app/apps/api/dist
```

The 937 KB API dist layer came from a clean comparison against `5fb7549`. All 158
compiled JavaScript files match a fresh local build, and the candidate Prisma
schema matches the checkout.

Reproduce isolated acceptance:

```bash
cd /home/hermes/MultiWA
AUTHZ_TEST_IMAGE=multiwa-api:stage2b2d-5fb7549-overlay \
AUTHZ_EXPECTED_IMAGE_ID=sha256:f4b0a187e5cc6376a322abb861343f3ff9866677983a72469971449c87e6f26a \
pnpm run test:authz-characterization:isolated
```

The runtime image is from `5fb7549`; characterization commit `9fcd5fe` supplies the
mounted test script.

## Limits and review stop

Guard-to-service profile reassignment races remain outside this batch. A successful
send persists before provider execution by existing design. The pending path can
therefore create a local message without a connected engine. API-key permission
semantics remain unchanged.

Stop for Astra review. Do not merge, deploy or begin the message-reference slice.
