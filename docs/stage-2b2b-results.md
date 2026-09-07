# Stage 2B.2B conversation detail protection

Candidate code commit: `00512fa1a9c4be68b8e11f7afac71c0782f923ac`.

Isolated fixture correction commit:
`abe13684996d923bb07c40d7a1a45a1e4270cc57`.

Candidate image: `multiwa-api:stage2b2b-00512fa`, image ID
`sha256:d45b317a3e7f76339ac76150c01c7d3563b62ee541d46eb0ce01b6111a274ac4`.

Live remains on Batch 2B.2A image
`sha256:faf91b6f31717dc0c8c73d11168c95623ec7e93e9eab58c19653e15240183bc4`.
Batch 2B.2B has not been merged or deployed.

## Change

`GET /api/v1/conversations/:id` now requires:

```ts
@RequireTenant({ resource: 'conversation', from: 'param', key: 'id' })
```

The existing JWT/API-key guard runs before `TenantGuard`. The route then applies
`ConversationDetailQueryPipe`, which accepts an omitted `messageLimit` or one
canonical decimal string from 1 through 100. Omission becomes numeric 50 before
the service call. Empty, whitespace, zero, negative, fractional, nonnumeric,
nonfinite, hexadecimal, exponent, repeated and over-limit values return 400.

Successful responses keep the existing conversation object, contact value and
message fields. The service still selects the newest N messages and reverses them
to chronological response order. No provider call is involved.

## Isolated HTTP acceptance

The exact candidate image ran with disposable PostgreSQL, Redis and API storage in
tmpfs. The runner mounted no live credentials, volumes or WhatsApp sessions. It
verified the image ID first. The candidate and checkout Prisma schemas had the
same SHA-256 digest.

The conversation-detail matrix made 45 real HTTP requests:

| Scenario | JWT | API key |
| --- | --- | --- |
| A1 contact-present conversation | 200, complete existing shape | 200, same shape |
| A2 contact-null empty conversation | 200, null contact and empty messages | 200, same shape |
| Omitted limit | Newest 50 in chronological order | Same |
| Limits 1, 2 and 100 | Exact expected complete rows | Same |
| Eleven malformed/repeated limit forms | 400 | 400 |
| Foreign and nonexistent IDs | Matching generic 404 | Matching generic 404 |
| Foreign/missing ID with invalid limit | 404 before limit validation | 404 before limit validation |
| Forged profile/organization selectors | 404 | 404 |
| Missing credential, invalid JWT and invalid API key | 401 | 401 |

Every request compares complete conversation and message rows from both synthetic
organizations immediately before and after it. Business writes and provider calls
were zero. API-key `lastUsedAt` is authentication bookkeeping and remains excluded
from business-write counts.

The characterization kept the full Batch 2B.1 read checks and Batch 2B.2A's
88-request mutation matrix. Four explicit later-stage gaps remain:

- static media is publicly readable;
- a read API key can register a legacy hook;
- legacy hooks are visible across organizations;
- API keys remain valid after their owner is deactivated.

## Verification

- Script syntax: passed.
- Focused controller, guard and service suites: 71 passed.
- Full API suite: 164 passed and two opt-in integration tests skipped.
- API typecheck and production build: passed.
- Authorization inventory mutation suite: 13 passed.
- Authorization inventory: 232 controller routes and four supplementary entries;
  71 protected, 153 confirmed gaps, eight intentional public and four needing a
  decision. Exactly one route moved from gap to protected.
- Public-boundary, API-contract, inventory and repository release checks: passed.
- Isolated real HTTP characterization: passed.

The first two Docker builds exhausted disk while Puppeteer unpacked and produced no
candidate. The successful build followed cleanup of regenerable caches and old
temporary test copies. Existing package deprecation warnings and the Docker legacy
builder warning remain unchanged. The first two characterization runs exposed
fixture collisions with earlier profile type/direction assertions; commit
`abe1368` isolates those rows without changing runtime code.

Reproduce acceptance with both recorded revisions checked out:

```bash
cd /home/hermes/MultiWA
AUTHZ_TEST_IMAGE=multiwa-api:stage2b2b-00512fa \
AUTHZ_EXPECTED_IMAGE_ID=sha256:d45b317a3e7f76339ac76150c01c7d3563b62ee541d46eb0ce01b6111a274ac4 \
pnpm run test:authz-characterization:isolated
```

The runtime image comes from `00512fa`; the runner mounts the characterization
script from `abe1368` read-only.

## Limits and rollback

The guard-to-service ownership race during concurrent profile reassignment remains
outside this batch. Message timestamp ties retain the existing database ordering.
No cursor pagination or response redaction was added.

No rollback is needed before release because this candidate is not live. A later
authorized release can restore the current Batch 2B.2A image above and recreate
only the Compose API service with `--no-deps --no-build`.

## Astra review handoff

Review `00512fa` and `abe1368`, plus the documentation follow-up. Check guard order,
the exact decorator, explicit query pipe, routed service-spy tests, all inventory
mutations and the 45-request detail matrix. Re-run the isolated command above and
confirm the 88-request mutation matrix plus four known gaps remain. Do not merge or
deploy during review.
