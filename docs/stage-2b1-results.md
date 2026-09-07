# Stage 2B.1 Payment Monitor read-route protection

Code commit: `f9c2effd874acc4a8a9b1b9c70a56391c079589c`.

Batch 2B.1 adds organization ownership checks to the Payment Monitor message,
media, sender-resolution, conversation-list/message-list and group-list routes.
The guard runs after JWT/API-key authentication and returns a non-disclosing 404
for a missing or foreign resource. Missing required selectors return 400 before
the service runs.

Media retrieval still accepts 1 to 50 message IDs and returns valid results in
the requested order. It now rejects malformed IDs and fails the entire request
when any requested row is absent or belongs to another profile.

## Isolated HTTP acceptance

| Scenario | Result |
| --- | --- |
| Same-organization profile messages | 200; metadata response fields preserved |
| Same-organization media batch | 201; original content and request order preserved |
| Foreign profile messages | 404 |
| Foreign profile media | 404 |
| Own profile with mixed own/foreign media IDs | 404; no partial response |
| Foreign sender-resolution profile | 404 before resolver execution |
| Foreign conversation list | 404 |
| Same-organization conversation messages | 200; chronological response preserved |
| Foreign conversation messages | 404 |
| Foreign group list | 404 before provider execution |
| Equivalent API-key foreign reads | 404 |
| DNT access flag true/string true/false | 200/404/404 |

The remaining characterization gaps are conversation detail, static media,
legacy hook ownership/scope and inactive-user API keys. Those belong to later
Stage 2 batches.

## Verification

- API compilation passed.
- Full API suite: 110 passed, two opt-in tests skipped in the ordinary run.
- Five tenant-guard tests passed.
- Three media metadata/batch tests passed.
- Updated two-organization characterization passed with synthetic records and
  isolated PostgreSQL/Redis/storage.
- Authorization inventory: 232 controller routes plus four supplementary
  entrypoints; 63 protected, eight intentional public, 161 confirmed gaps and
  four decision-required.
- API contract and inventory checks passed.

No schema, response payload, credential or Payment Monitor client change is
required. No live WhatsApp sender-resolution request is part of acceptance.
