# Stage 2B.2E message-reference sends

Runtime source commit: `89f5e0e733ced5a58ca4c9dfcad7a53055f9a841`.
Characterization and inventory commit:
`9ca8586978474328aae8c29371530b6ff5581416`.
Parent-containment correction commit:
`f8665233951b318cf82fbeca2eb027d87516240b`.

Candidate image: `multiwa-api:stage2b2e-89f5e0e-overlay`, image ID
`sha256:a54a10a8873a605403eb3fc131399fc031bb0c1c5e117020dcf9d840d5ca38ce`.
Its parent is live Batch 2B.2D image
`sha256:e386f6af397676b2b68c0bb3e8139972f2adfaa7c1ee064cee60be4557cd47dc`.
Live remains on the parent; this candidate is not deployed.

## Change

POST `/messages/text`, `/reply` and `/reaction` now verify body profile ownership.
Referenced IDs are local Message IDs and must match that exact profile and a
conversation with the same profile. Providers receive the stored WhatsApp message
ID. Unquoted text remains valid. Quoted text must target the referenced conversation;
reply and reaction destinations come from the authorized message.

## Acceptance

The 66-request reference-send matrix completed 16 successes and 50 denials for JWT
and API-key callers across connected A1 and disconnected A2 profiles. It covers
unquoted and quoted text, replies, reactions, same-organization cross-profile and
cross-organization references, missing and inconsistent parents, forged selectors,
mismatched destinations, owned-invalid DTOs and invalid credentials. Every denial
compares complete business records for both organizations. Denied writes were zero.
The inconsistent-parent fixture uses the requested profile on the message while
its conversation belongs to another profile, so the test independently exercises
the conversation-parent predicate for all three routes and both credentials.

Success checks compare complete responses, persisted content/local quote links,
derived conversations and provider IDs. Mock text acknowledgements reach terminal
`read`; mock reactions intentionally remain `sent` because their adapter has no
acknowledgement callback.

Prior 126/63/45/88-request matrices and four known gaps remain. Focused tests: 20
passed. Full API suite: 273 passed with two opt-in skips. Inventory tests: 19 passed.
Inventory totals are 84 protected, 140 confirmed gaps, eight intentional public
and four decision-required across 236 entries.

## Candidate and rerun

Dependencies and schema are unchanged. The candidate overlays freshly compiled API
dist on Batch 2B.2D. All 160 compiled JavaScript files match the checkout.
Reproduce acceptance:

```bash
cd /home/hermes/MultiWA
AUTHZ_TEST_IMAGE=multiwa-api:stage2b2e-89f5e0e-overlay \
AUTHZ_EXPECTED_IMAGE_ID=sha256:a54a10a8873a605403eb3fc131399fc031bb0c1c5e117020dcf9d840d5ca38ce \
pnpm run test:authz-characterization:isolated
```

Stop for Astra review. Scheduling and remaining ownership gaps stay outside this batch.

The Baileys adapter currently ignores quoted-text options, and its reaction method
returns success without sending through the socket. Mock acceptance proves API
ownership, persistence and ID translation; it does not claim those two Baileys
provider capabilities work.
