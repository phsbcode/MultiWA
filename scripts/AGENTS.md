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
| `archive-container-logs.mjs` | Continuously archives MultiWA API Docker stdout/stderr into private gzip segments with bounded retention |
| `multiwa-log-archive.service` | User systemd service for the collector, installed under `~/.config/systemd/user/` |
| `watch-transport-socket.mjs` | Read-only, exact-tuple `/proc` socket metadata observation for one connection generation |
| `capture-transport-headers.sh` | Separately operator-authorized host capture of one IPv4 tuple, Ethernet/TCP headers only |
| `continue-transport-investigation.mjs` | Bounded next-event continuation for a verified, uniquely named Herdr investigator |

## Local Contracts

- Scripts are POSIX-shell or Node.js
- Scoped socket observation reads only already-accessible `/proc/<pid>/net/tcp`, retains the chosen IPv4 tuple/inode, and never reconnects or captures payloads. Stop on inode replacement, prolonged absence, or at most 24 hours. Store private gzip segments with one-day / 16 MiB retention and a 2 GiB free-space reserve; optional Herdr notification is one-way and once per run. A retransmission-timeout counter is not a complete packet-loss or retransmission measurement. Privileged capture, namespace entry, firewall and kernel inspection require explicit access; do not bypass denied host permissions through containers.
- Header capture requires a reviewed host sudo invocation, exact tuple/inode validation, an empty private directory, a 54-byte Ethernet/IPv4 snaplen, four 1 MB rotating files, at most six hours, and a 2 GiB reserve plus 8 MiB headroom. Stop within 30 seconds of the original inode disappearing. Schedule deletion of that run's packet files after 24 hours before launch. Never capture on `any`, store full packets, decrypt TLS, broaden to unrelated traffic, or infer WhatsApp application intent from FIN/IP evidence alone.
- Keep packet output in a mode-0700 `/tmp/multiwa-mm-headers-*` or `/var/tmp/multiwa-mm-headers-*` directory owned by the invoking user. The installed tcpdump AppArmor profile denies home dot-directories; do not disable or weaken that profile. The collector installs the owning user's 24-hour packet-expiry timer before capture and caps tcpdump stderr at 64 KiB plus the bounded timer setup output. Preserve failed-run logs, use a fresh directory, and rebind/rearm the consumed one-shot continuation from a genuine Herdr host context after a startup correction.
- Next-event continuation must inherit a genuine Herdr caller context and bind a unique live agent name to its verified terminal ID and working directory, plus session ID when available. Never use focus or a stale inherited pane ID. Submit once on socket/capture change or bounded expiry, without `--wait`; refuse replaced identities, leave blocked approval UIs alone, and never retry an ambiguous submission. No stable-state reports or automated reconnects.
- Preserve Docker logs before rotation using the continuously running archive service. Default archive policy is seven days, 512 MiB compressed total, and a 2 GiB free-space reserve; capacity limits may shorten retention. Never prune Docker files, containers, volumes, or unrelated files from the collector.
- Archive data lives in `~/.local/state/multiwa-log-archive/` with directory mode 0700 and files 0600. Raw logs may contain private data. Do not print their contents into service diagnostics or commit archives to Git.
- Install the collector in `~/.local/libexec/` and enable the user service with lingering. It follows the named container across replacement, replays a one-minute cursor overlap after restart, and commits archives before checkpoints. Duplicate records across restart are expected. A stopped collector can only recover logs Docker still retains.
- The collector writes gzip JSONL records with container ID, stdout/stderr stream, capture time, and raw Docker log text in `data`. Verify archives with gzip decompression; use `jq -r '.data'` after decompression for authorized inspection.
- `check-api-contract.mjs` is the gateway for API compatibility checks
- `api-routes.snapshot.json` is the source of truth for route validation
- Authorization inventory updates are drafts until selector, evidence and status fields are reviewed; its checker must keep known gaps visible.
- Profile-message characterization verifies conversation filtering with and without `since` for JWT and API keys, including missing/other-profile conversations, foreign-profile denial, and unchanged business records in both synthetic organizations.
- The isolated runner initializes its tmpfs database from the candidate image's Prisma schema using the workspace Prisma CLI; slim runtime images do not need the development CLI installed.
- Retain isolated API test containers stopped after verification, alongside the test DB/Redis containers. Do not remove test configurations as disposable build artifacts; container removal is limited to explicitly authorized older MultiWA rollbacks.
- Mutation characterization must compare complete records from both synthetic organizations immediately before and after each denied request.
- Provider-backed characterization must wait for inert asynchronous acknowledgements to settle before zero-write snapshots; failure output must not dump complete records.
- Authorization inventory supports explicit profile, conversation and message tenant resources; the message resource must verify both organization ownership and conversation-parent consistency.

## Work Guidance

- New scripts should follow existing patterns (bash for shell tasks, .mjs for Node)
- Scripts that validate contracts should be added to CI workflows in `.github/`

## Verification

- Run `node --test scripts/archive-container-logs.test.mjs` for compression, retention, capacity refusal, and restart cursor tests. Verify the installed user service and live gzip archives after changes.
- Run `node --test scripts/watch-transport-socket.test.mjs` for exact tuple filtering and kernel field parsing before starting bounded observation.
- Run `bash -n scripts/capture-transport-headers.sh` and its unprivileged `--check` with the reviewed target before requesting capture access; offline truncated-header fixtures can verify decoding without network capture.
- Run `node --test scripts/capture-transport-headers.test.mjs` to exercise the installed tcpdump's permitted temporary-file output, private permissions, four-file rotation and 54-byte records entirely offline.
- Run `node --test scripts/continue-transport-investigation.test.mjs` before arming a continuation; verify identity rejection and event-only triggering without sending a test prompt to a live agent.

## Child DOX Index

No child AGENTS.md files.
