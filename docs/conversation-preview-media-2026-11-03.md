# Conversation-list media payload correction, 3 November 2026

## Failure and correction

DNT Payment Monitor group discovery used the authorized, profile-scoped
conversation list. Its latest-message content could include an entire encoded
attachment. A 79,101,614-byte QuickTime document had 105,468,936 bytes of stored
JSON, exceeding the consumer's 50 MB Apps Script fetch limit before supported
media filtering. Five other text receipts were blocked alongside that event.

`ConversationsService.findAll` now removes media `content.url` and
`content.base64` in the PostgreSQL projection, before loading content into Node.
A defensive response projection enforces the same preview boundary. Text,
captions, filenames, MIME types, IDs and status are preserved. Original stored
messages and authorized full-media endpoints are unchanged. No authorization,
route, dependency, schema or connection-recovery rule changed.

The API specification and owning `apps/AGENTS.md` document that contract. Root,
Docker and scripts DOX files were reviewed; their purpose, child indices and
operational contracts did not change.

## Verification

- Six media-type regressions failed against the original service and pass with
  the correction. Focused conversation/controller/media tests: 78 passed.
- Complete API suite with an inert synthetic DATABASE_URL: 362 passed, two
  skipped. Typecheck and release/route/auth inventory checks passed, including
  19 inventory tests. Lint cannot run because the repository has no ESLint
  configuration; this preexisting limitation was not masked.
- The isolated authorization characterization passed against the candidate.
  A synthetic 105,468,876-character data URL produced list responses below
  8,192 characters on three reads. Metadata and the source database value were
  independently checked and preserved.
- Admin conversation-list rendering reads text/caption and type placeholders;
  it does not use the removed preview payload fields.
- Authenticated Payments TEST browser discovery, 46 groups and 20 warm samples
  per phase, improved from median/p95 3,658.20/4,333.20 ms to
  2,625.40/3,299.80 ms. Current list JSON decreased from 962,515 to 60,139
  characters. All reads succeeded; first observations were kept separate.
  This external-service path still has a p95 above three seconds and is not
  certified as an indexed-read timing pass. Historical baselines were preserved
  in the Payments repository's response standards and baseline history.

## Runtime and recovery

The existing pinned runtime-update Dockerfile overlaid one typed, compiled
conversation service module. The same compiler path reproduced the original
running module byte-for-byte before producing the candidate. The deployed
module matches the tested candidate exactly.

- Active image: `multiwa-api:conversation-preview-20261103`,
  `sha256:bcaf2c4ab84b8e103d49a659a57336b90cdfd0eb090d235cc6b46ede6ed7a879`.
- Immediate predecessor: `multiwa-api:rollback-before-media-preview-20261103`,
  `sha256:b533d73241df560a70a1d15d80d3c393fbfd1ae7f86113e9b65f30e6e50fa41b`.
  Its stopped container is
  `multiwa-api-rollback-before-conversation-preview-20261103`.

The predecessor was healthy before shutdown. It exceeded the 90-second stop
timeout and exited 137; credentials and both named mounts were preserved. The
replacement retains the exact environment, loopback port bindings, healthcheck,
logging, restart policy and network configuration. It is healthy and WhatsApp
automatically reconnected at 22:51:00.387 UTC, settling at 22:51:30.839. The
durable earliest gap remains 29 September, with revision 839; consumer catch-up
continues independently and was not globally acknowledged or reset. Bounded old
container logs were archived privately before replacement.

The six retained blocked intake receipts were requeued through the authenticated
expected-attempt-count recovery RPC. All completed on the first recovery
attempt. The unsupported video correctly produced no review; five text events
also completed without creating reviews. At 22:58:47 UTC the worker was healthy
with zero pending, processing, finalizing or blocked events. The 365-row payment
submission log's digest was identical before and after. No payment was submitted.
Temporary Apps Script support helpers used only the existing intake worker;
versioned dashboard, signed receiver and Contacts deployments were not changed.

At 23:01:30 UTC an independent authenticated read reconfirmed a healthy idle
worker, no queued/blocked/processing/finalizing events, connected WhatsApp and
zero unresolved errors after the three historical reports were resolved through
fresh expected-version RPCs. Consumer transport catch-up had progressed to 14 of
42 groups without an error. Both user-confirmed payer names remain Needs Review
at version 2. Fresh source/deployment readback confirmed 66 exact restored files,
no temporary helpers and dashboard/receiver/Contacts versions 125/116/111.

## Docker closeout

After verifying active health and immediate-predecessor identity/configuration,
the older `multiwa-api-rollback-service503-20261001` container was removed under
the one-predecessor retention policy. Its image remains required by three
unrelated retained test containers and was preserved. Every other preexisting
container and every named volume remains, including stopped test environments.

Unused builder-cache and dangling-image cleanup each reported **0 bytes**;
there were no unused build artifacts left. These artifacts can be regenerated
from the retained source and base image. Filesystem availability after cleanup
was 21,032,722,432 bytes (80% used); concurrent filesystem activity means its
observed change is not an exact attribution of container cleanup savings. The
active API remained healthy. No volume, unrelated stopped container or required
image was pruned.

Restricted source snapshots, container configuration, test logs, timings and
recovery readbacks are under
`/home/hermes/.config/dnt-test/conversation-media-fix-20261103-8m2jamim/`.
Container configuration and raw logs contain private data and must not be copied
into public diagnostics.
