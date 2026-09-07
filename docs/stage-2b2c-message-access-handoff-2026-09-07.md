# Batch 2B.2C: message reads and local deletion

## Objective and release boundary

Sol protects exactly three existing routes and closes the conversation cursor
containment gap within the first route. Produce an isolated, tested draft PR for
Astra review. Do not merge, deploy or begin another batch.

Planning baseline is main `1700a87fe903fdbd90e11653972742d613db985f`.
Current accepted Batch 2B.2B image:
`multiwa-api:stage2b2b-00512fa`,
`sha256:d45b317a3e7f76339ac76150c01c7d3563b62ee541d46eb0ce01b6111a274ac4`.
Verify current git and live image state before work. Read root and applicable
child AGENTS.md files. Fetch main, preserve later/uncommitted work, create a feature
branch and save sanitized source/deployment metadata outside the repository.

## Exact route scope

All paths start with `/api/v1/messages`.

| Route | Handler | Required tenant metadata |
| --- | --- | --- |
| GET `/conversation/:conversationId` | findByConversation | resource: conversation, from: param, key: conversationId |
| GET `/:id` | findOne | resource: message, from: param, key: id |
| DELETE `/:id` | delete | resource: message, from: param, key: id |

Use `@RequireTenant` with these exact values, all required. Preserve the existing
`JwtOrApiKeyGuard, TenantGuard` order. JWT and API-key access remains organization
wide, including other profiles in the caller's organization. Missing or foreign
resources return the same generic 404 before service execution. Missing/invalid
credentials return 401. Missing runtime organization context remains denied.

Add the bounded `message` resource to the tenant type, guard and inventory validator.
Resolve the local database message ID through its stored profile, workspace and
organization. Do not interpret `:id` as a WhatsApp provider message ID or accept a
caller-supplied profile/organization as authority.

Single-message detail includes the conversation. The schema stores message profile
and conversation separately, so also verify their profile IDs agree before exposing
the nested conversation or deleting the message. Fail closed with generic 404 for
inconsistent synthetic parentage. A narrow metadata lookup returning profileId and
conversation.profileId is sufficient; never load message content for authorization.
Use explicit guard branches for profile, conversation and message; unknown resource
types must fail closed rather than falling through to conversation lookup.

Keep all other tenant behavior unchanged. Add guard regression tests for existing
resource types and the new message branch.

## Cursor containment and successful contracts

`MessagesService.findByConversation` currently looks up `before` globally and
silently ignores a missing cursor. Scope that lookup to the already authorized
conversation, following the existing `ConversationsService.getMessages` pattern.
Missing cursors, cursors from another conversation in the same organization, and
cross-organization cursors must return the same generic cursor 404. Resolve
authorization before cursor lookup. Do not change another endpoint's pagination.

Preserve:

- `{ messages, hasMore }` for conversation message reads. Select newest N and
  return them chronologically, with all existing fields retained.
- The complete single-message object with its nested conversation for detail.
- `{ success: true }` for local deletion. Delete only the selected local message;
  retain its conversation, sibling messages and all other records.
- The current `hasMore` heuristic, including its behavior on exactly N rows.
  Do not replace it with lookahead in this batch.

Before edits, characterize omitted and valid explicit `limit` values against an
isolated baseline. Preserve the existing successful limit behavior and default 50;
do not silently introduce the separate detail route's 100 maximum. If existing
conversion prevents valid calls, make only the demonstrated route-local correction,
with tests and documented before/after evidence. Any broader limit redesign needs
a separate decision.

Local deletion must never call delete-for-everyone or any provider operation.
Do not adjust unread counts, recompute last-message time, purge media or repair
parentage as part of deletion. Those are separate behavior changes.

## Files and inventory

Expected paths:

- `apps/api/src/modules/messages/messages.controller.ts` and `.service.ts`.
- Focused/routed specs under the messages module.
- `apps/api/src/common/tenant/require-tenant.decorator.ts`, `tenant.guard.ts`
  and guard specs.
- `scripts/authz-inventory-lib.mjs`, `check-authz-inventory.test.mjs`,
  `authz-routes.inventory.json`, and `authz-characterization.mjs`.
- `docs/07-api-specification.md`, `authorization-inventory.md`,
  `stage-2a-results.md`, new `stage-2b2c-results.md`, and owning AGENTS.md.

No schema migration, dependency upgrade or global validation change is expected.
Avoid unrelated formatting. Update the strict inventory resource allowlist to
accept message without weakening its metadata parser.

Exactly three routes move from confirmed-gap to protected. Against the recorded
baseline, totals become 74 protected and 150 confirmed gaps, with 236 total entries.
Public route counts remain unchanged. Inspect every regenerated inventory change.

Extend decorator/guard mutation checks across all three routes: removal, line/block
comments, resource/from/key changes, optional true including quoted optionality,
computed values, spreads, duplicate/unsupported fields, and guard removal/comments.
Retain all earlier checks. Prove each mutation actually changes the intended source.

## Required isolated acceptance

Use synthetic organizations A and B, profiles A1/A2 and B1, and fresh conversation
and message fixtures. Use real supported message types and directions. Create new
fixtures after existing assertions or in dedicated profiles to avoid polluting
earlier filter/order tests.

For each route and both JWT and API-key callers:

1. Owned A1 and A2 resources succeed with exact expected response fields.
2. Foreign and missing IDs return matching generic 404 bodies, including forged
   profile/organization selectors in requests. GET bodies, if tested, must use an
   HTTP client that actually transmits them; do not silently omit them.
3. Missing credentials, invalid JWT and invalid API key return 401.
4. Read requests leave complete fixture records unchanged. Immediately before and
   after each denied request, compare complete conversations and messages from
   both organizations. Include contents, metadata and timestamps, not only counts.
5. Successful local deletion removes exactly one message and leaves its conversation,
   sibling messages and the other organization unchanged. Use fresh targets for
   each successful credential case. Repeat deletion receives generic 404.
6. Inconsistent message/conversation profile parentage is denied for both credentials,
   including a foreign nested conversation. No service or provider call occurs.

Conversation reads additionally prove valid cursor pages using explicit expected
IDs and unique timestamps, chronological ordering, omission/default behavior,
explicit limits, empty conversations and the unchanged hasMore heuristic. Deny
missing cursors, same-organization foreign cursors and cross-organization cursors.
Test foreign conversations with invalid cursors to prove ownership runs first.

Add routed Nest/Fastify service-spy tests with real TenantGuard and production
validation configuration. Denials must not invoke the service; allowed controls
must invoke the correct method once. Add service-level provider/engine spies proving
all three paths are provider-free. Do not rely on hardcoded report counters as proof.

Keep the complete prior 45-request detail and 88-request mutation matrices and
Batch 2B.1 read compatibility assertions. Retain all four recorded later-stage gaps:
public static media, read-key hook creation, cross-organization hook visibility,
and inactive-user API keys. These new protected routes were inventory gaps, not
additional entries in that four-gap characterization list.

## Candidate, CI and cleanup

Run focused tests, API typecheck/build, full API suite, inventory checks and
`pnpm run check:release`. Record real totals and opt-in skips. Local node_modules
may need restoring from the lockfile. Use only synthetic database configuration.

Build a newly tagged API image from a clean recorded source commit and verify its
compiled controller/guard and schema against source. Do not retag latest. Record
the runtime revision separately from any subsequent mounted test-script revision.

```bash
cd /home/hermes/MultiWA
AUTHZ_TEST_IMAGE=multiwa-api:stage2b2c-COMMIT \
AUTHZ_EXPECTED_IMAGE_ID=sha256:DIGEST \
pnpm run test:authz-characterization:isolated
```

Replace placeholders with the built tag and digest. Validate the runner's reused
containers, tmpfs and mounts before execution; attach no live credentials, sessions
or volumes. No live mutation acceptance is authorized.

Check disk headroom before starting. Earlier builds exhausted disk and left large
stopped intermediate containers. Preserve every container as instructed; do not
repeat builds that cannot fit or delete unrelated projects/caches to force progress.
Use a verified build location with sufficient space, or report the exact space
requirement and bounded cleanup options before destructive expansion.

After Docker work remove task-created disposable images and unused build cache,
preserving all containers, volumes, active images and retained rollback/candidate
images. Verify service health and disk usage and report actual reclaimed space.

Commit/push scoped work including this prepared handoff, open a draft PR, and check
CI for its final head. Do not change GitHub Pages settings or unrelated workflows.
Write results with exact commits/image, reproducible command, per-route evidence,
test totals, compatibility decisions, known limits and rollback image. State that
guard-to-service races during concurrent parent reassignment remain outside scope.

## Final stop

No send/reply/reaction, typing, provider mark-read/delete-for-everyone, schedule,
participants, uploads/static media, hooks, key scopes/lifecycle or socket changes.
No Operations or Payment Monitor code changes. No live reviews, Register writes,
payment submissions, scans, messages, credential changes or Drive sharing changes.

Finish with a concise Astra review prompt. Live remains on Batch 2B.2B until a
separate release authorization. Do not start the next batch.
