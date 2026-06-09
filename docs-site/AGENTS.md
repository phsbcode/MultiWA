# AGENTS.md — docs-site/

## Purpose

Docusaurus-powered documentation website for MultiWA. Mirrors and extends `docs/` content for public-facing documentation.

## Ownership

- `docusaurus.config.ts` — site configuration
- `sidebars.ts` — navigation structure
- `src/pages/` — custom pages (landing, etc.)
- `docs/` — Docusaurus-flavored markdown, organized into categories: getting-started, architecture, features, api, sdks, operations
- `static/` — static assets (images, icons)

## Local Contracts

- Content sourced from `docs/` with possible reformatting for Docusaurus
- Sidebar structure in `sidebars.ts` must reflect the doc organization
- Build produces static site deployable to GitHub Pages

## Work Guidance

- New docs in `docs/` should be added to `docs-site/docs/` and `sidebars.ts`
- Use Docusaurus markdown features (admonitions, tabs, code blocks) where appropriate

## Verification

- `pnpm build` in `docs-site/` produces no errors or broken links
- Deployed via `.github/workflows/docs-deploy.yml`

## Child DOX Index

No child AGENTS.md files.
