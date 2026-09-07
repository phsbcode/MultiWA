# Stage 2A authorization characterization results

Baseline: `21722ff6d2dddc752aaed9ed8d158589306326d9`.
Environment: actual MultiWA API image with disposable PostgreSQL, Redis, session,
hook and media storage. All identities and records were synthetic.

Stage 2A changed no runtime authorization. It records current behavior for Stage 2B.

## Observed HTTP behavior

| Scenario | Result | Classification |
| --- | --- | --- |
| Missing or invalid credentials on profiles | 401 | Protected |
| Organization A profile list | 200; excluded B profiles | Protected |
| Organization A direct lookup of B profile | 404 | Protected |
| Organization A reads B profile messages | 200 | Confirmed gap |
| Organization A retrieves B profile media by B message ID | 201 | Confirmed gap |
| Organization A lists B profile conversations | 200 | Confirmed gap |
| Organization A reads B conversation detail | 200 | Confirmed gap |
| A1 profile with A2 conversation/message context | 404 | Child containment protected |
| DNT flag boolean true/string true/boolean false | 200/404/404 | Exact boolean protected |
| Unauthenticated synthetic static media | 200 | Confirmed gap |
| Read, empty and wildcard API keys perform profile read | 200/200/200 | Current compatibility |
| `messages:read` key registers legacy hook | 201 | Confirmed scope gap |
| Organization B lists Organization A legacy hook | 200 | Confirmed ownership gap |
| API key after owner deactivation | 200 | Confirmed lifecycle gap |
| Profile with null workspace read through scoped profile route | 404 | Current fail-closed behavior |

The current schema requires `User.organizationId`, so a persisted user principal
without an organization could not be constructed. Stage 2 guards must still reject
missing runtime organization context before building ORM filters.

Conversation detail without `messageLimit` returned 500 because Prisma received an
invalid `take`. The characterization supplies `messageLimit=50`. Track that defect
separately; it is not an authorization result.

## Stage 2B enforcement backlog

### Batch 2B.1: Payment Monitor reads

- `MessagesController.findByProfile`: require caller ownership of `profileId`.
- `MessagesController.findMediaByProfile`: require profile ownership and restrict
  every body `ids` item to that profile before returning any row.
- `MessagesController.resolveSenderPhones`: require profile ownership and retain
  the 50-LID bound; treat it as metadata repair when assigning permission.
- `ConversationsController.findAll`: require ownership of query `profileId`.
- `ConversationsController.getMessages`: resolve conversation ownership before read.
- `GroupsController.getAll`: require ownership of path `profileId`.
- Preserve `ProfilesController.status`, DNT profile/group routes and existing
  context/search containment behavior.

Acceptance: two-organization JWT and API-key HTTP tests; foreign and mixed-parent
IDs denied without partial response data; current DNT response fields, filtering,
ordering and bounds unchanged.

### Batch 2B.2: message and conversation mutations

Protect every send, schedule, delete, mark-read, archive, mute, pin and participant
operation by the supplied profile/conversation/group and child IDs. Do not infer
ownership from a WhatsApp JID. Validate quoted messages, cursors and scheduled IDs
against the same parent. Address static media access through an authenticated or
short-lived evidence route without breaking original-slip review.

### Batch 2B.3: remaining profile-owned resources

Apply organization and parent checks to contacts, templates, automations,
autoreplies, broadcasts, webhooks, knowledge documents, uploads, statistics and
integrations. Add resource-specific real HTTP tests before reducing each inventory
gap.

### Batch 2B.4: administrative resources

Add role enforcement to organization members, workspaces, RBAC, settings and audit
operations. Current organization-ID use alone is insufficient for administrative
mutations. Keep self-service auth, notification and API-key operations user-scoped.

### Stage 2C and 2D decisions

- Carry stored permissions into the API-key principal and enforce the UI's exact
  scope names. Preserve the live empty-permission key until ownership is resolved.
- Reject keys whose owning users are inactive.
- Define a permission for group/conversation reads and sender resolution without
  silently breaking Payment Monitor.
- Assign an authoritative organization/profile set to each legacy hook before
  restricting list, registration, deletion and dispatch. Never auto-assign old
  hooks to the first caller.
- Test both `/ws` gateway implementations on their shared namespace before changing
  subscription authorization.

## Reproduction

`scripts/authz-characterization.mjs` requires an isolated API and database through
`AUTHZ_CHARACTERIZATION=1`, `AUTHZ_TEST_BASE_URL` and `DATABASE_URL`. Set
`AUTHZ_STATIC_FIXTURE=1` only after placing the named synthetic file in isolated
media storage. The runner asserts expected baseline statuses, deletes its synthetic
organizations and disconnects Prisma. Hook and media fixtures remain isolated in
the stopped test API container and contain no live data.

This file preserves the pre-enforcement baseline. The characterization runner
now tracks Batch 2B.1 expectations; see `stage-2b1-results.md` for current results.

The prepared local environment can be rerun with
`pnpm run test:authz-characterization:isolated`. It starts and stops only the
preserved Stage 2A test containers and never mounts live sessions or credentials.
