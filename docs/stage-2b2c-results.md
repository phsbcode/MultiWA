# Stage 2B.2C message access protection

Candidate runtime head: `d3bc7258c8e261886814d5689a1fbc11b241b6f9`.
Characterization and inventory follow-up:
`7cefc0625a70708a67b1a4b25e9eabc767abf6aa`.

Candidate image: `multiwa-api:stage2b2c-d3bc725-overlay`, image ID
`sha256:920bc9d3336b928a552b6a22aa28526874c74a8c2315f6f5c49b65d56de18026`.

Live remains on Batch 2B.2B image
`sha256:d45b317a3e7f76339ac76150c01c7d3563b62ee541d46eb0ce01b6111a274ac4`.
Batch 2B.2C has not been merged or deployed.

## Change

Three existing routes now enforce organization ownership:

- `GET /api/v1/messages/conversation/:conversationId` checks the conversation.
- `GET /api/v1/messages/:id` checks the local message.
- `DELETE /api/v1/messages/:id` checks the local message.

Message ownership follows its stored profile to workspace and organization, then
requires that profile ID to match the nested conversation profile ID. Unknown
tenant resource types fail closed. Authentication remains before tenant ownership.
Missing, foreign and inconsistent resources return a generic 404 before service
execution.

Conversation pagination now resolves `before` only inside the selected authorized
conversation. Missing, same-organization foreign and cross-organization cursors
return `Pagination cursor not found.` without running the message query. Omitted
and valid explicit limit behavior remains unchanged: default 50, numeric query
values are converted to numbers before service execution, newest rows are returned
chronologically and `hasMore` is true when the returned count equals the requested
limit. Missing values remain optional and malformed integer values return 400
before service execution.

Single-message detail retains the full message plus nested conversation. Local
deletion retains `{ success: true }`, deletes only the selected database message,
and performs no WhatsApp provider operation.

## Isolated HTTP acceptance

The candidate ran with disposable PostgreSQL, Redis and API storage in tmpfs. The
runner mounted no live credentials, volumes or WhatsApp sessions and verified the
image ID before testing.

The message-access matrix made 63 real HTTP requests. For JWT and API-key callers
it verified:

- A1 and A2 conversation reads, message detail and local deletion.
- Default, limit-2, cursor, populated A2 and empty-conversation response contracts
  with explicit IDs, full fields, chronological ordering and the existing `hasMore`
  behavior. Fifty-two supported incoming text fixtures prove that omission retains
  the default limit of 50.
- Foreign/missing conversations and messages, forged query/body selectors, and
  inconsistent message/conversation parents return matching generic 404 responses.
- Missing, same-organization foreign and cross-organization cursors return the
  same cursor 404. Foreign conversation ownership runs before cursor lookup.
- Missing credentials, invalid JWT and invalid API key return 401 on all routes.
- Each successful deletion removes one target while retaining its conversation,
  siblings and the other organization. Repeated deletion returns 404.

Every read and denied request compares complete conversation and message fixtures
from both organizations immediately before and after execution. Denied business
writes were zero. API-key `lastUsedAt` remains authentication bookkeeping. Focused
engine-manager spies prove all three service paths are provider-free.

The same run retained the full Batch 2B.1 compatibility checks, 45-request detail
matrix and 88-request conversation-mutation matrix. Four later-stage gaps remain:

- static media is publicly readable;
- a read API key can register a legacy hook;
- legacy hooks are visible across organizations;
- API keys remain valid after their owner is deactivated.

## Verification

- Script syntax: passed.
- Focused guard/controller/service suites: 27 passed. The routed controller suite
  installs the production validation pipe and proves an explicit limit reaches the
  service as a number. It also proves omitted limits succeed and malformed limits
  stop before service execution.
- Full API suite: 186 passed and two opt-in integration tests skipped.
- API typecheck and production build: passed.
- Authorization inventory mutation suite: 15 passed.
- Inventory: 232 controller routes and four supplementary entries; 74 protected,
  150 confirmed gaps, eight intentional public and four needing a decision. Exactly
  three routes moved from gap to protected.
- Public-boundary, API-contract, inventory and repository release checks: passed.
- Isolated real HTTP characterization: passed.
- Read-only live Batch 2B.2B baseline confirmed default and limit-2 conversation
  reads returned 200, stayed bounded and chronological.

An initial re-review suite invocation omitted the synthetic `DATABASE_URL`, so two
constructor-only suites stopped before collecting tests. The complete rerun used
the isolated synthetic database setting and passed. No live database was used.

The review corrections use supported incoming text fixtures in dedicated profiles,
so they cannot change earlier profile-message assertions. Fifty-two ordered A1
messages prove the default limit, a populated A2 conversation proves organization-
wide access for both credentials, and the empty-conversation case remains. Adding
the production validation pipe to the routed suite exposed that primitive implicit
conversion did not provide a reliable optional integer. A route-local pipe now
preserves omission, converts valid integers and rejects malformed values.

## Candidate construction

The standard API Dockerfile exhausted the host disk while copying its unchanged
dependency tree and produced no candidate. Repeating that build would have created
more multi-gigabyte stopped intermediate containers, which project rules preserve.

The tested candidate is a reproducible 923 KB runtime overlay on the accepted
Batch 2B.2B image. The base already contains the unchanged dependencies, entrypoint
and Prisma schema. `apps/api/dist` was built locally after the full typecheck/tests;
`git diff` confirmed API source and schema matched `d3bc725` before staging it.

The overlay Dockerfile was:

```dockerfile
FROM multiwa-api:stage2b2b-00512fa
COPY dist /app/apps/api/dist
```

Image history records parent
`sha256:d45b317a3e7f76339ac76150c01c7d3563b62ee541d46eb0ce01b6111a274ac4`.
The candidate and checkout Prisma schema SHA-256 are both
`ea0ad1e0f1a9dd85b7c3681079235ab31026746fb2625fd66651f2ce6e88e09f`.
Compiled output contains all three decorators, the message guard branch, scoped
cursor query and route-local optional integer conversion.

Reproduce isolated acceptance:

```bash
cd /home/hermes/MultiWA
AUTHZ_TEST_IMAGE=multiwa-api:stage2b2c-d3bc725-overlay \
AUTHZ_EXPECTED_IMAGE_ID=sha256:920bc9d3336b928a552b6a22aa28526874c74a8c2315f6f5c49b65d56de18026 \
pnpm run test:authz-characterization:isolated
```

## Limits and rollback

Guard-to-service races during concurrent parent reassignment remain outside this
batch. Local delete intentionally leaves conversation counters and last-message
time unchanged. The existing `hasMore` heuristic and timestamp tie behavior remain.

No rollback is needed before release because this candidate is not live. A later
authorized release can retag the current Batch 2B.2B image above and recreate only
the Compose API service with `--no-deps --no-build`.

## Astra review handoff

Review the original `40e2004` implementation and corrections through `d3bc725`,
plus characterization commit `7cefc06` and the documentation follow-up. Confirm
the two prior findings are closed: production-style routed validation now covers
omitted, numeric and malformed limits; the 63-request matrix uses supported,
isolated fixtures and proves default-50 plus populated A2 access. Recheck parent
consistency, exact decorators, cursor scoping, inventory mutations, retained 45/88
matrices, four known gaps and overlay lineage. Rerun the command above. Do not merge
or deploy during review.
