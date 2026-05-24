# Architecture SOP Index

This folder is Layer 1 of the BLAST A.N.T. model.

Status: initialized, no workflow-specific SOP approved yet.

SOPs:

- `link-verification.md`: local `.env`, database, Redis, Prisma, Docker, and API handshake checks.
- `worker-recovery.md`: restore and verify the internal worker container.
- `pln-batam-hardening.md`: harden internal server env and runtime before production signoff.
- `public-release-boundary.md`: define public-safe vs internal-only release content.
- `internal-deploy-runbook.md`: deploy and verify internal server changes with rollback.

Rules:

- Add or update the relevant SOP before changing behavior.
- Each SOP must define purpose, input, output, tool logic, edge cases, and technical rules.
- If later implementation or testing reveals a new API constraint, payload rule, rate limit, or failure mode, update the SOP so the same issue is not repeated.
- Keep deterministic execution in `tools/` or existing application services. The navigation/reasoning layer should orchestrate, not perform hidden business logic.
