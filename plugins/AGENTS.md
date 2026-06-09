# AGENTS.md — plugins/

## Purpose

Plugin system for MultiWA. Contains example plugins and the plugin loading infrastructure.

## Ownership

- `example-logger/` — Example plugin demonstrating the plugin API
- Plugin loading is handled by `apps/api/src/modules/plugins/`

## Local Contracts

- Plugins implement the plugin interface from `apps/api/src/modules/plugins/plugin.interface.ts`
- Plugins are loaded at runtime by the plugin loader service

## Work Guidance

- New plugins should be self-contained directories under `plugins/`
- Follow the `example-logger` structure as a template
- Register in the plugin system via configuration

## Verification

- Plugin loading validated by API startup logs
- No automated test suite for plugins currently

## Child DOX Index

No child AGENTS.md files.
