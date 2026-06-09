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

## Verification

- `docs-site/` build validates that doc references are valid
- Manual review for accuracy against code

## Child DOX Index

No child AGENTS.md files.
