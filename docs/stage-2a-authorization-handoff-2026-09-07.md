# Stage 2 review and Stage 2A handoff for Sol

Reviewed baseline: `21722ff6d2dddc752aaed9ed8d158589306326d9`.
Upstream reference: `ff51e79dd83da6fd5dee71765dfaf0ea71ae0d24`.
Parent plan: `upstream-sync-plan-2026-09-07.md`.

Implementation result: `stage-2a-results.md` and `authorization-inventory.md`.

## Review conclusion

Proceed with Stage 2A as an inventory and characterization change. Do not install
authorization guards, migrate hook ownership or change API-key semantics in 2A.
The subsequent enforcement changes need the evidence produced here.

## Verified implementation risks

| Risk | Current evidence | Required treatment |
| --- | --- | --- |
| Existing protection is uneven | `ProfilesService.findOne` scopes by workspace organization; its callers and DNT flag checks already protect profile operations. Conversation search/context use an access helper, while ordinary list/detail/read/archive/message-list routes do not invoke that helper. | Trace every controller through its service/query. Do not classify an entire controller by one protected method. |
| Missing organization can remove a Prisma filter | Existing helpers accept an organization string and build relation filters; the API schema permits nullable profile workspace/account relations. | Record principal validation and actual ownership path. Later guards must reject missing organization before constructing queries. Do not add an account-derived ownership fallback without verifying its business meaning. |
| Foreign child IDs can bypass a profile check | Media batches, conversation context, pagination cursors, assignments and quoted-message IDs carry secondary selectors. | Inventory all selectors and prove child-to-parent containment, even when both resources belong to one organization. |
| Scope names differ from upstream assumptions | Database/API use `permissions`; current API-key strategy does not return them in its principal. UI offers messages, contacts, profiles, webhooks and broadcast permissions. | Map stored permissions to proposed capabilities explicitly. GET/POST alone cannot decide permissions: media POST is retrieval; sender resolution may repair stored identity metadata. |
| Legacy hooks have no ownership | `HookRegistration` has no organization/profile field; `/hooks` authenticates but lists/registers/removes globally. Dispatcher also needs inspection for event isolation. | Treat read, registration, deletion and delivery filtering as one ownership problem. Never assign old hooks to the first requester. Plan an explicit trusted ownership migration in 2D. |
| Controller snapshot omits other entrypoints | Swagger-excluded controllers are skipped by the existing contract script. `main.ts` serves `/uploads/media/` through Fastify static registration. Socket.IO is a separate entrypoint. | Keep a supplementary entrypoint inventory. Swagger exclusion does not mean public or safe. Do not claim complete coverage from the 231-route snapshot alone. |
| Mutation targets extend beyond resource IDs | Membership, role assignment, contact assignment and organization/workspace creation can accept writable relationship fields. | Record role requirements and body fields that can change ownership. Authentication plus ownership is not sufficient for administrative actions. |
| Global guards may run before authentication | `DemoGuard` is registered as APP_GUARD and may deny mutations before route authentication in demo mode. | Record actual execution order and DEMO_MODE. Do not apply blanket HTTP-401 expectations to intentional demo behavior. |
| Security tests could invoke real integrations | Engine initialization, automation, hook callbacks and notifications have side effects. | Use isolated database/Redis and inert adapters. No live credentials/session mounts, provider calls or deliveries. |
| A green coverage test can hide real gaps | A manifest can acknowledge an unprotected route without enforcing anything. | Distinguish inventory completeness, observed behavior and desired policy. Report gap counts visibly; never label baseline characterization as enforcement. |

## Deliverables

1. `scripts/authz-routes.inventory.json`: reviewed machine-readable route inventory.
2. `scripts/check-authz-inventory.mjs`: check source/inventory parity, schema and evidence.
3. `scripts/check-authz-inventory.test.mjs`: meaningful checker tests with synthetic source fixtures.
4. `docs/authorization-inventory.md`: rendered overview, unresolved decisions and
   prioritized Stage 2B batches, generated from the inventory where possible.
5. Isolated characterization tests for representative DNT routes using the actual
   registered controllers, production authentication/authorization chain and real
   Prisma queries. Use the existing framework; no framework upgrade.
6. `docs/stage-2a-results.md`: exact baseline, route counts, tests, gaps and handoff.
7. Update nearest AGENTS.md guidance and add runnable package commands for the
   checker. Add a CI inventory gate only after its baseline is complete.

Read root, scripts, apps, docs and .github AGENTS.md as applicable before editing.
The new files above are proposed outputs, not files already present.

## Inventory record contract

Use `METHOD /api/v1/path` as the stable route key. Each entry must include:

- Controller path, class and handler; source references for effective guards.
- Access category: public, authenticated-user, organization, administrative or
  legacy-global. Record the implemented category separately from desired policy.
- Accepted principals: JWT, API key or explicitly unauthenticated.
- Every resource selector: location/path, type, required/optional, parent selector,
  ID namespace and any normalization. Distinguish database message UUID, provider
  message ID, group JID and LID; never assume they are interchangeable.
- Current principal validation, ownership query and role checks with file/symbol
  evidence. `not_checked` and `unknown` are distinct outcomes; unknown needs a
  concrete follow-up before inventory acceptance.
- Side effects, proposed permission and compatibility notes for current callers.
- Target policy and status: protected, intentional-public, confirmed-gap or
  decision-required. Exceptions need rationale and a named follow-up stage.

Use synthetic examples only. Do not store actual profile IDs, keys, URLs containing
secrets, WhatsApp identities or customer data in the inventory.

## Route discovery and checker

Start from `scripts/api-routes.snapshot.json` and the controller extractor, then
independently inspect route registration. Use TypeScript AST/reflection where
needed instead of assuming a short regex decorator window is complete.

Check all controller methods, including Swagger-excluded endpoints, route aliases,
method/class decorator precedence and inherited/composite decorators if present.
Reconcile counts to the public snapshot and explain every difference. Keep static
media, health/docs, Socket.IO and any other plugin routes in a second section with
their registration evidence and separate coverage totals.

The checker must fail on missing/duplicate/stale route keys, malformed records,
missing evidence, invalid parent-selector references or undocumented exceptions.
It must NOT fail merely because a known gap still exists in the accepted 2A
baseline. Print counts of protected routes, intentional public routes, known gaps
and decisions outstanding. Later stages turn selected target policies into
mandatory behavioral assertions and reduce the accepted gap list explicitly.

Checker fixtures must cover a new route, a deleted route, a wrong handler,
Swagger exclusion, an unclassified selector and a public route accidentally
reclassified. Do not test only that the checked-in JSON equals its own snapshot.

## Priority inspection list

Inspect all routes, starting with these examples:

- `GET /messages/profile/:profileId`, media POST and resolve-senders POST.
- `/conversations` list/detail/message-list and mutation methods, plus existing
  search/context access checks and child-ID constraints.
- Ordinary profiles and `/profiles/.../dnt-operations`, including its exact boolean flag.
- `/groups/profile/:profileId`, DNT group discovery and group participant mutations.
- Legacy `/hooks` plus database-backed `/webhooks`; inspect delivery filtering too.
- API key management, organizations, workspaces, accounts/GDPR, role management,
  settings, notifications, statistics, uploads and integrations.
- Static media downloads, webhook inbound receivers and Socket.IO rooms/events.

Also record which Payment Monitor and Operations clients call these routes by
inspecting their source. Do not rewrite those clients as part of the inventory.

## Isolated characterization matrix

Use two synthetic organizations; two profiles in organization A and one in B;
conversations/messages for each; user/member/admin JWT sessions; expired/invalid
credentials; explicitly read-only, write, empty-permission and wildcard API keys.
Create these only in the isolated database.

Record observed and desired outcomes separately:

| Case | What Stage 2A must establish |
| --- | --- |
| Missing/invalid credentials | Actual protected-route status and absence of sensitive response data. |
| Same-organization access | Existing DNT read behavior and response shape remain usable. |
| Foreign profile/resource | Whether current code denies it or demonstrates a confirmed gap with synthetic data. |
| Profile A1 plus child from A2 | Containment behavior even within one organization. |
| Organization A profile plus B media/message/cursor | Independent child selector cannot be assumed safe. |
| Missing or malformed principal organization | Whether an unchecked ORM filter can become broader. |
| Read-only API key on mutation | Current permissions enforcement, observed with inert external adapters. |
| DNT flag false/string/true | Existing exact-boolean access restriction remains characterized. |
| Legacy hooks | Existence of missing ownership, using synthetic registrations and no actual delivery. |

Known insecure behavior may be characterized only when explicitly named as a
gap. Keep the desired-denial scenarios in the matrix for Stage 2B, not silently
skipped tests presented as passed enforcement. Do not deliberately exploit live
cross-organization routes to prove the gaps.

No live write/scan/send test is needed for 2A. Do not invoke the live resolver as
a supposedly pure read: it can now update older message identity metadata.

## Key and hook compatibility decisions

Prefer source and existing configuration evidence. If existing key permission
distribution must be checked, use read-only aggregate counts with no hashes,
prefixes, names or secrets in output. Record missing evidence honestly.

Explicitly resolve or assign to the next stage:

- Whether empty permissions and wildcard keys retain legacy full capability.
- Permission mapping for groups, conversations, resolver and legacy hooks where
  the UI has no dedicated permission. Do not invent new required scopes silently.
- Handling of inactive users behind otherwise valid API keys.
- Ownership of profiles with null workspaceId or conflicting account/workspace links.
- Authoritative owner and allowed event profiles for existing legacy hooks.
- Whether denied existing resources use 403 or non-disclosing 404 consistently.
- How static media authorization can be enforced without breaking original-slip access.

## Acceptance and next handoff

Stage 2A is complete when every registered route/entrypoint has a reviewed entry,
all selectors have a classified ownership path, no unexplained unknowns remain,
checker tests pass, isolated characterization results are reproducible, and the
Stage 2B batches identify exact handlers, target checks and compatibility impacts.

Run the inventory checker, focused checker tests, existing API contract/release
checks and relevant characterization tests. Use one test environment; avoid a
full Docker rebuild for each inventory edit. Clean disposable build output while
preserving containers/volumes per workspace rules; report actual disk recovery.

No application deployment, migration or credential rotation is part of 2A.
Do not merge enforcement changes into this inventory commit. Record source
commit and test totals and provide the next concrete 2B task for review.

Suggested Sol instruction:

> Implement Stage 2A using docs/stage-2a-authorization-handoff-2026-09-07.md.
> Produce the complete route inventory, checker and isolated characterization
> evidence. Preserve existing runtime behavior and finish with an explicit
> Stage 2B enforcement backlog.
