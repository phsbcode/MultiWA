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

## Local Contracts

- Scripts are POSIX-shell or Node.js
- `check-api-contract.mjs` is the gateway for API compatibility checks
- `api-routes.snapshot.json` is the source of truth for route validation

## Work Guidance

- New scripts should follow existing patterns (bash for shell tasks, .mjs for Node)
- Scripts that validate contracts should be added to CI workflows in `.github/`

## Verification

- Scripts are invoked manually or via CI; no automated test suite for them currently

## Child DOX Index

No child AGENTS.md files.
