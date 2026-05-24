# Public Release Boundary SOP

Status: draft (boundary audit run 2026-05-23)

## Purpose

Define what can be pushed to the public GitHub repository and what must remain internal-only.

## Inputs

- Current git worktree.
- `gemini.md` release boundary.
- Explicit internal-only path list from the user or repository owner.
- Secret scan and git status output.

## Public-Safe Areas

These are generally safe if they contain no real credentials or internal identifiers:

- Application source code under `apps/` and `packages/`.
- Generic docs under `docs/`.
- Generic Docker templates and examples.
- SDKs, plugins, and integration adapters with placeholder credentials.
- Sanitized screenshots and public marketing assets.

## Internal-Only Areas

Do not push these to the public release unless explicitly sanitized and approved:

- `.env`, `.env.*.local`, server-specific env files, credentials, keys, tokens, session artifacts, logs, dumps, backups, and `.tmp/`.
- WhatsApp session directories (`sessions/`, `apps/*/sessions/`, `.wwebjs_auth/`, `.wwebjs_cache/`) and QR/session material.
- Server access details, jump host details, internal hostnames/IPs, private deployment notes, customer data, or message logs.
- BLAST memory files: `findings.md`, `progress.md`, `task_plan.md`, `gemini.md`. These now contain internal server findings (server paths, SSH alias names, hardening flow) and must remain internal-only as-is.
- `CLAUDE.md` while it imports `gemini.md` via `@gemini.md`. If `CLAUDE.md` is ever made public, the gemini import must be replaced with a public-safe equivalent first.
- Internal SOPs that mention the internal server path or operational details: `architecture/pln-batam-hardening.md`, `architecture/internal-deploy-runbook.md`, `architecture/worker-recovery.md`, and `architecture/link-verification.md` (mentions PLN Batam path selection).

## Boundary Audit Findings (2026-05-23)

These observations come from running the secret/internal-indicator scan with the SOP's pattern set, plus filesystem checks:

- No real production secret was found in the working tree. All `PASSWORD|SECRET|TOKEN|PRIVATE KEY|BEGIN RSA|BEGIN OPENSSH` matches in tracked or untracked files at the workspace root are either: documentation, placeholder strings (e.g., `change-this-...`, `dev-...-in-production`, `your-secure-generated-secret-key-here`, `minio123`, `minioadmin`), or example/test fixtures inside `node_modules/` dependencies.
- No internal IP, jump host IP, internal domain, or live operator password leaked outside the BLAST memory + internal-SOPs scope. Specific internal markers were checked during the audit and are recorded only in internal BLAST memory.
- `apps/api/sessions/` is 187 MB on disk and `apps/api/.wwebjs_cache/` is 2.8 MB. Both are gitignored (`.gitignore` lines 59 and 61) and verified untracked. They will not appear in a public push but should be wiped from any workstation that is shared, backed up, or transferred.
- `.env.docker` is tracked and intentionally contains only DEV placeholders (`change-this-...`, localhost URLs). It is safe to keep public as a Docker development template.
- `docs-site/build/` and `docs-site/.docusaurus/` are gitignored via `docs-site/.gitignore`. No build bundle is tracked.

## Hardened Gitignore Guidance

To prevent accidental commit of internal-only files via a stray `git add .`, the project `.gitignore` should explicitly list the BLAST memory and internal SOPs:

```
# BLAST internal memory (operational detail, not public-safe)
/findings.md
/progress.md
/task_plan.md
/gemini.md
/CLAUDE.md

# Internal-only SOPs (mention server paths, hardening flow)
/architecture/pln-batam-hardening.md
/architecture/internal-deploy-runbook.md
/architecture/worker-recovery.md
/architecture/link-verification.md
```

If the project later splits architecture into public and internal trees, prefer a directory pattern like `/architecture/internal/` over per-file entries.

## File Classification at Last Audit (2026-05-23)

Public-safe (untracked, would be safe to add):

- `.env.server.example` — generic env template, no real values.
- `.gitignore` modification — ignore rule updates.
- `architecture/README.md` — placeholder SOP index.
- `architecture/public-release-boundary.md` — this SOP itself; generic and reusable.
- `tools/link_check.py` — generic Link handshake script with no embedded credentials.

Internal-only (untracked; do not stage for public push):

- `findings.md`, `progress.md`, `task_plan.md`, `gemini.md`, `CLAUDE.md`.
- `architecture/pln-batam-hardening.md`, `architecture/internal-deploy-runbook.md`, `architecture/worker-recovery.md`, `architecture/link-verification.md`.

Already in repository and reverified public-safe:

- Source under `apps/`, `packages/`, `plugins/`, `landing/`.
- Public docs under `docs/`, `docs-site/docs/`.
- Top-level public docs: `LICENSE`, `README.md`, `CHANGELOG.md`, `CODE_OF_CONDUCT.md`, `CONTRIBUTING.md`, `PRIVACY.md`, `SECURITY.md`.
- `Dockerfile`, `docker/`, `docker-compose.yml`, `docker-compose.dev.yml`, `docker-compose.production.yml`.
- `.env.example`, `.env.docker`, `.env.production.example` (tracked DEV templates with placeholder values only).

## Pre-Push Checks

Run before any public push:

```bash
git status --short --untracked-files=all
git diff --check

# Secret scan. Note: ripgrep's -E with '|' alternation can return zero against an
# untracked workspace on some platforms; scan per-pattern or filter via grep -v.
FILTER='(node_modules/|docs-site/node_modules/|\.git/|\.tmp/|\.pnpm-store/|\.turbo/|\.next/|dist/|build/)'
for pat in PASSWORD SECRET TOKEN 'PRIVATE KEY' 'BEGIN RSA' 'BEGIN OPENSSH'; do
  echo "--- $pat ---"
  rg -nI --no-heading --no-ignore-vcs -F "$pat" . 2>/dev/null | grep -vE "$FILTER" | head -20
done

# Internal markers specific to the operator environment.
# Fill these from an internal-only note, not from committed public docs.
for pat in '<internal-ip-prefix>' '<jump-host-ip-prefix>' '<internal-domain-fragment>' '<known-password-fragment>' '<internal-host-alias>'; do
  rg -nI --no-heading --no-ignore-vcs -F "$pat" . 2>/dev/null | grep -vE "$FILTER" || true
done

# Private RFC1918 ranges in non-vendor paths.
rg -nI --no-heading --no-ignore-vcs -P '\b10\.\d{1,3}\.\d{1,3}\.\d{1,3}\b' . 2>/dev/null | grep -vE "$FILTER" | head -10
```

Any match must be reviewed and either removed, redacted, or documented as a harmless placeholder. Documentation strings like `change-this-...`, `dev-...-in-production`, and `your-...-here` are placeholders and acceptable; production-looking opaque strings inside committed files are not.

## Output

- A public release candidate with internal-only files excluded.
- A short release note describing public-safe changes.
- A record in `progress.md` that secret/public-boundary checks were run.

## Technical Rules

- Never push real server credentials, internal network details, or server env files.
- Treat BLAST memory as internal unless sanitized for public release.
- Public examples must use placeholder domains and placeholder credentials only.
- If unsure whether a file is public-safe, exclude it and ask.
