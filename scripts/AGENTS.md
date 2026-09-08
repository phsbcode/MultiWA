# AGENTS.md — scripts/

## Purpose

Utility scripts for development, code review, API contract validation, and CI/CD automation.

## Ownership

| Script | Purpose |
|--------|---------|
| `auto-review.sh` | Automated code review runner |
| `check-api-contract.mjs` | Validates API routes match documented spec |
| `check-public-boundary.sh` | Checks public API surface boundaries |
| `install-hooks.sh` | Installs git hooks |
| `test-webhook.sh` | Tests webhook delivery |
| `webhook-receiver.js` | Test webhook receiver server |
| `api-routes.snapshot.json` | Snapshot of all API routes for contract checking |
| `authz-routes.inventory.json` | Reviewed route, selector, ownership and permission inventory |
| `check-authz-inventory.mjs` | Validates authorization inventory against current source |
| `authz-characterization.mjs` | Runs opt-in HTTP characterization against isolated services |
| `run-authz-characterization-isolated.sh` | Reuses the preserved isolated containers to run authorization characterization without live credentials |

## Local Contracts

- Scripts are POSIX-shell or Node.js
- `check-api-contract.mjs` is the gateway for API compatibility checks
- `api-routes.snapshot.json` is the source of truth for route validation
- Authorization inventory updates are drafts until selector, evidence and status fields are reviewed; its checker must keep known gaps visible.
- Mutation characterization must compare complete records from both synthetic organizations immediately before and after each denied request.
- Provider-backed characterization must wait for inert asynchronous acknowledgements to settle before zero-write snapshots; failure output must not dump complete records.
- Authorization inventory supports explicit profile, conversation and message tenant resources; the message resource must verify both organization ownership and conversation-parent consistency.

## Work Guidance

- New scripts should follow existing patterns (bash for shell tasks, .mjs for Node)
- Scripts that validate contracts should be added to CI workflows in `.github/`

## Verification

- Scripts are invoked manually or via CI; no automated test suite for them currently

## Child DOX Index

No child AGENTS.md files.
