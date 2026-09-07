# Stage 2B.2A conversation mutation protection

Candidate code commit: `e9fad0cb6082c9316440eb22115e0be04d84259e`.

Cross-organization snapshot correction:
`494c0d818b20f23f012189d17a8fa3883b1affcd`.

Routed service-spy and per-request snapshot correction:
`9c709c2b184ce042d76231b37cbac2e47d40726c`.

Candidate image: `multiwa-api:stage2b2a-494c0d8`, image ID
`sha256:faf91b6f31717dc0c8c73d11168c95623ec7e93e9eab58c19653e15240183bc4`.

PR 7 merged to `main` as `a92a76c60649cd622e171991f97b34d8bad63f29`.
Live runs the candidate image above from 7 September 2026. The accepted Batch
2B.1 image `sha256:a332d5526e08bae77337ba7112fde5409fb8f2153fef3de9f954f04918afdda1`
is retained as the rollback image.

## Change

The following existing routes now declare the same required conversation
ownership check:

```ts
@RequireTenant({ resource: 'conversation', from: 'param', key: 'id' })
```

- `PUT /api/v1/conversations/:id/read`
- `PUT /api/v1/conversations/:id/archive`
- `PUT /api/v1/conversations/:id/unarchive`
- `PUT /api/v1/conversations/:id/mute`
- `PUT /api/v1/conversations/:id/pin`
- `DELETE /api/v1/conversations/:id/messages`
- `DELETE /api/v1/conversations/:id`

`JwtOrApiKeyGuard` still runs before `TenantGuard`. The guard follows conversation
to profile, workspace and organization. It ignores profile and organization values
forged in the query or body.

## Isolated HTTP acceptance

The candidate ran against disposable PostgreSQL, Redis and API storage in tmpfs.
The runner mounted no live credentials or WhatsApp sessions. It verified the image
ID before starting the API and confirmed the candidate Prisma schema has the same
SHA-256 digest as the checked-in schema.

| Scenario, repeated for all seven routes | JWT | API key |
| --- | --- | --- |
| Conversation under another profile in the caller's organization | 200 with the existing exact response | 200 with the same response |
| Foreign organization conversation | 404 | 404 |
| Missing conversation | 404, same body as foreign | 404, same body as foreign |
| Forged query and body selectors on a foreign conversation | 404 | 404 |
| Missing or invalid credential | 401 | 401 |
| Denied business writes | 0 | 0 |

The mutation matrix made 88 HTTP requests: 70 denied requests and 18 successful
explicit actions. Fresh fixtures prevented an earlier delete from turning later
foreign tests into missing-record tests. Every denied request compares complete
conversation and message records from both organizations immediately before and
after that request.

Successful behavior was checked in the database:

- Mark-read reset only the selected unread count and marked only its messages read.
- Archive and unarchive retained their existing metadata replacement behavior.
- Mute and pin each toggled true and then false through separate requests.
- Clear removed only selected messages and reset its counters.
- Delete removed only the selected conversation and messages.
- A neighboring conversation and its messages stayed unchanged for every success.

API-key `lastUsedAt` updates are authentication bookkeeping. They are not counted
as business writes.

## Verification

- Syntax check for `scripts/authz-characterization.mjs`: passed.
- Focused controller, guard and service suites: 42 passed. The routed controller
  cases prove each denied request avoids its service method and each authorized
  request invokes it once.
- Full API suite: 135 passed and two opt-in integration tests skipped.
- API typecheck and production build: passed.
- Authorization inventory mutation suite: 13 passed.
- Authorization inventory: 232 controller routes and four supplementary entries;
  70 protected, 154 confirmed gaps, eight intentional public and four needing a
  decision. Exactly seven routes moved from gap to protected.
- Public-boundary, API-contract, inventory and repository release checks: passed.
- Isolated real HTTP characterization: passed, including all preserved Batch 2B.1
  assertions and the five known later-stage gaps.
- Live API health: passed. Payment Monitor reported MultiWA connected, automatic
  intake healthy and 45 group options available.
- Read-only Payment Monitor adapter: summary, queue, detail, evidence metadata and
  a protected PDF evidence file returned 200. Missing credentials returned 401,
  and the read-only key received 403 on a write route.

The first full API run failed before collecting two suites because the local Prisma
client had not been generated after dependencies were restored. Generating the
client fixed the environment issue; the rerun passed all runnable tests. The Docker
build used Docker's legacy builder and printed existing package deprecation
warnings. Neither warning changed the candidate output.

Reproduce the isolated acceptance with:

```bash
cd /home/hermes/MultiWA
AUTHZ_TEST_IMAGE=multiwa-api:stage2b2a-494c0d8 \
AUTHZ_EXPECTED_IMAGE_ID=sha256:faf91b6f31717dc0c8c73d11168c95623ec7e93e9eab58c19653e15240183bc4 \
pnpm run test:authz-characterization:isolated
```

## Known limits and rollback

This batch does not make service operations transactional and does not close the
guard-to-service ownership race if administrators reassign a profile concurrently.
Archive and unarchive still replace metadata. Mute and pin remain non-idempotent
toggles and must not be retried automatically. Conversation detail, static media,
hooks, API-key permission enforcement and inactive-user keys remain explicit gaps.

Rollback by tagging the retained Batch 2B.1 image as `multiwa-api:latest`, then
recreate only the Compose `api` service with `--no-deps --no-build`. Verify API,
PostgreSQL and Redis health plus Payment Monitor reads after recovery. Do not run
live conversation mutations as acceptance tests.

Headless browser acceptance could not establish the Google staff web-app session
because neither retained OAuth profile supplied the required Google cookies. The
same finance-reviewer identity successfully loaded the queue, detail and protected
preview through the read-only Apps Script adapter. No dashboard or Apps Script code
changed in this release.

## Astra review result

Astra found two acceptance-test gaps. Commits `9c709c2` and `2416750` closed them
with routed controller service-spy tests and complete two-organization snapshots
around every denied request. The independent rerun found no release-blocking issue.
