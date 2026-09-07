# AGENTS.md — docs/

## Purpose

Comprehensive project documentation covering architecture, setup, API specification, SDK usage, deployment, and operational guides.

## Ownership

All `.md` files in `docs/` covering:
- Project overview, requirements, quick start
- System architecture, database design, engine abstraction
- API specification, WebSocket API, webhook events
- Messaging, groups, automation
- SDK documentation (Python, PHP, n8n)
- Deployment, development, configuration, database backup
- Branding, testing guide, implementation plans

## Local Contracts

- Docs use standard markdown
- API spec in `07-api-specification.md` is the authoritative reference for SDKs and integrations
- Screenshots stored in `docs/screenshots/`
- Doc content may be mirrored to `docs-site/` for the Docusaurus site

## Work Guidance

- API changes must update `07-api-specification.md` first
- Architecture changes should update `04-system-architecture.md` and `05-database-design.md`
- New features should get a doc following the existing numbering scheme
- `upstream-sync-plan-2026-09-07.md` defines the staged selective upstream port, DNT compatibility checks and release checkpoints for the September 2026 synchronization work.
- `stage-2a-authorization-handoff-2026-09-07.md` defines authorization inventory and characterization deliverables before Stage 2 enforcement changes.
- `authorization-inventory.md` summarizes the checked route inventory and DNT compatibility boundaries; `stage-2a-results.md` records isolated baseline behavior and the Stage 2B backlog.
- `stage-2b1-results.md` records Payment Monitor read-route enforcement and its isolated acceptance evidence.
- `stage-2b2a-conversation-handoff-2026-09-07.md` bounds Sol's next implementation to seven conversation mutation ownership checks, isolated acceptance and Astra review before release.
- `stage-2b2a-results.md` records the candidate identity, seven-route mutation matrix, zero-denied-write evidence and Astra stop point.
- `stage-2b2b-conversation-detail-handoff-2026-09-07.md` bounds the next batch to conversation-detail ownership, message-limit validation and isolated acceptance before Astra review.

## Verification

- `docs-site/` build validates that doc references are valid
- Manual review for accuracy against code

## Child DOX Index

No child AGENTS.md files.
