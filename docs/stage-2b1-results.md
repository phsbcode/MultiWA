# Stage 2B.1 Payment Monitor read-route protection

Candidate code commit: `ebe8a71ba471c3b41297c78522eff08e0d6ddf07`.

Acceptance correction commit: `7f7226b14061c2e3bd0392b1c911c804146893c5`.

Strict metadata parsing commit: `7648656ed8ca4a8e009498075a89fc4d8861fefd`.

Candidate image: `multiwa-api:stage2b1-review-ebe8a71`, image ID
`sha256:a332d5526e08bae77337ba7112fde5409fb8f2153fef3de9f954f04918afdda1`.

The accepted Batch 2B.1 image above is retained as the rollback baseline for the
live Batch 2B.2A release.

Batch 2B.1 adds organization ownership checks to the six Payment Monitor read
routes for messages, media, sender resolution, conversations and groups. The
guard runs after JWT or API-key authentication. It returns a non-disclosing 404
for a missing or foreign resource and a 400 for a missing required selector.

## Astra review corrections

1. Conversation pagination now resolves `before` only inside the authorized
   conversation. Missing cursors, same-organization cursors from another
   conversation, and cross-organization cursors all return the same 404.
2. The authorization inventory records each `@RequireTenant` resource, source,
   key and optional flag, along with its enforcing guards. Mutation tests remove
   every protected route's decorator, change each selector field, enable the
   optional flag, and remove `TenantGuard`. A strict token parser handles quoted
   properties by their runtime meaning and rejects computed values, spreads,
   duplicate fields, unsupported fields and malformed expressions. Every mutation
   fails the checker.
3. The isolated runner starts the selected `AUTHZ_TEST_IMAGE` as the API under
   test. It compares the selected image ID with `AUTHZ_EXPECTED_IMAGE_ID`, names
   the API container from that digest, verifies the container image, creates the
   schema, and requires tmpfs for PostgreSQL, Redis, API data, media and sessions.
   It mounts no credentials or WhatsApp sessions.
4. HTTP characterization now covers both accepted and denied JWT and API-key
   calls on all six routes. It also covers filters, pagination, ordering, mixed
   media ownership, request order, the 50-ID limit, and successful group and
   sender-resolution calls through the inert mock adapter.

## Isolated HTTP acceptance

| Scenario | Result |
| --- | --- |
| JWT access to all six own-resource routes | 200 or 201, as defined by the existing routes |
| API-key access to all six own-resource routes | 200 or 201, matching JWT response contracts |
| Foreign access to all six routes with JWT | 404 |
| Foreign access to all six routes with API key | 404 |
| Valid conversation cursor | 200; chronological page preserved |
| Missing, same-organization foreign and cross-organization cursors | 404 with the same non-disclosing response |
| `since`, type, direction, limit and offset | 200; expected records and ordering returned |
| Conversation limit and cursor pagination | 200; expected page order and `hasMore` preserved |
| Same-organization and cross-organization mixed media IDs | 404; no partial response |
| Media request order | 201; response follows requested ID order |
| 50 distinct media IDs | 201; all requested rows returned in request order |
| 51 media IDs | 400 |
| Groups through the mock adapter | 200; deterministic mock groups returned |
| Sender resolution through the mock adapter | 201; deterministic mock mapping returned |

The isolated run verified image
`sha256:a332d5526e08bae77337ba7112fde5409fb8f2153fef3de9f954f04918afdda1`
before HTTP testing. It used synthetic organizations, profiles, messages and API
keys. The cleanup removed the synthetic organizations, and stopping the
containers discarded all tmpfs data.

## Verification

- API compilation passed.
- Full API suite: 114 passed; two opt-in integration tests skipped.
- Conversation service suite: 13 passed, including three cursor ownership cases.
- Authorization inventory mutation suite: 12 passed, including commented
  decorators, commented guards, quoted optionality, computed values and spreads
  across all six protected routes.
- Authorization inventory: 232 controller routes and four supplementary
  entrypoints. It records 63 protected, eight intentional public, 161 confirmed
  gaps and four decision-required entries.
- Public-boundary, API-contract, inventory and repository release checks passed.
- Exact candidate isolated HTTP acceptance passed.

Run the same acceptance check with:

```bash
cd /home/hermes/MultiWA
AUTHZ_TEST_IMAGE=multiwa-api:stage2b1-review-ebe8a71 \
AUTHZ_EXPECTED_IMAGE_ID=sha256:a332d5526e08bae77337ba7112fde5409fb8f2153fef3de9f954f04918afdda1 \
pnpm run test:authz-characterization:isolated
```

The runner preserves its stopped test containers for inspection but stores their
database and files only in tmpfs. Starting a new run reprovisions the schema.

## Remaining Stage 2 work

The characterization still records five known gaps. They are unchanged by this
batch:

- conversation detail accepts a foreign conversation ID;
- static media files lack authentication and ownership checks;
- a read API key can register a global legacy hook;
- legacy hooks are visible across organizations;
- API keys remain usable after their owning user is deactivated.

These gaps belong to later Stage 2 batches. No live provider call is part of this
acceptance. The mock adapter is available only when `NODE_ENV=test`; production
falls back to the existing supported engine selection.

## Astra re-review handoff

Review `ebe8a71`, `7f7226b`, `7648656` and the documentation follow-up. Check the cursor lookup in
`ConversationsService.getMessages`, the exact tenant metadata captured by
`authz-inventory-lib.mjs`, every mutation in
`check-authz-inventory.test.mjs`, and the image and tmpfs checks in
`run-authz-characterization-isolated.sh`. Re-run the command above and confirm
the six-route JWT/API-key matrix and inert-provider assertions in
`authz-characterization.mjs`.
