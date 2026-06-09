# AGENTS.md — .github/

## Purpose

GitHub configuration: CI/CD workflows, issue templates, pull request template, and funding configuration.

## Ownership

- `workflows/ci.yml` — CI pipeline (lint, test, typecheck, build)
- `workflows/docker-publish.yml` — Docker image publish
- `workflows/docs-deploy.yml` — Docusaurus site deploy to GitHub Pages
- `workflows/release-gate.yml` — Release quality gate checks
- `workflows/release.yml` — Release workflow
- `ISSUE_TEMPLATE/bug_report.md` — Bug report template
- `ISSUE_TEMPLATE/feature_request.md` — Feature request template
- `PULL_REQUEST_TEMPLATE.md` — PR template
- `FUNDING.yml` — GitHub Sponsors config

## Local Contracts

- CI must pass for PR merge
- Releases follow semantic versioning
- Docs site deploys from `docs-site/` build

## Work Guidance

- New workflows should follow existing naming and structure
- Secrets are managed via GitHub Actions secrets

## Verification

- Workflows are validated by GitHub Actions on push/PR
- `act` (local GitHub Actions runner) for local testing

## Child DOX Index

No child AGENTS.md files.
