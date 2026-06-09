# AGENTS.md — code-review/

## Purpose

Records of automated code reviews. Each timestamped review file captures the output of review tooling runs.

## Ownership

- Timestamped review files: `review-YYYYMMDD-HHMM`
- Each review contains analysis findings for a specific codebase snapshot

## Local Contracts

- Review files are read-only records; do not modify after creation
- Naming convention: `review-{date}-{time}` in 24h format

## Work Guidance

- New reviews append as new files; never overwrite existing reviews
- Reviews are triggered by `scripts/auto-review.sh`

## Verification

No automated verification for review records.

## Child DOX Index

No child AGENTS.md files.
