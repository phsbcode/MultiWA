# Demo Capture Guide

Public-safe shot list and sanitation rules for the 30-60 second MultiWA
demo asset that ships in the root README and the project landing page.

This guide describes **what to record and how to redact it**. It does not
include any internal MultiWA deployment details. Do not capture from an
internal or production environment.

---

## Goals

- Show a developer the full onboarding loop in under one minute.
- Make it obvious that MultiWA is one `docker compose up` away from a
  working WhatsApp gateway, an admin dashboard, and a Swagger UI.
- Avoid any marketing fluff. Each shot proves a concrete capability.

---

## Equipment

- Any screen recorder that exports `.mp4`, `.webm`, or `.gif`.
- A throwaway browser profile (no extensions, no logged-in accounts) so
  saved credentials cannot appear on screen.
- A clean shell with no command history, no aliases, and no shell prompt
  hostname.
- A throwaway WhatsApp number for the QR scan (never your personal or
  PLN Batam number).

---

## Environment Setup

Run the public Docker stack on your laptop, not on any internal server.

```bash
git clone https://github.com/ribato22/MultiWA.git
cd MultiWA
cp .env.docker .env
docker compose up -d
```

Confirm:

- Admin: `http://localhost:3001`
- API Swagger: `http://localhost:3333/api/docs`

If any of these resolve to anything other than localhost, stop and switch
environments.

---

## Shot List (target: 45 seconds)

| # | Approx duration | Shot | What it proves |
|---|-----------------|------|----------------|
| 1 | 5 s | Terminal: `docker compose up -d` then `docker ps` showing five healthy `multiwa-*` containers | One-command setup |
| 2 | 4 s | Browser opening `http://localhost:3001`, MultiWA login | Admin UI exists |
| 3 | 6 s | Sign up / login form, redirected to the dashboard | Onboarding is built in |
| 4 | 5 s | Dashboard: "Create profile" button, profile creation modal | First-class multi-profile UX |
| 5 | 8 s | Profile detail showing QR code, scan with a throwaway phone, status flips to "Connected" | Real device link |
| 6 | 6 s | Send a text message from the Send composer, recipient receives it on the throwaway phone | Live messaging |
| 7 | 5 s | Switch to a webhook endpoint terminal (e.g. `ngrok` or a local echo), incoming webhook payload prints | Webhook events fire |
| 8 | 4 s | Open `http://localhost:3333/api/docs` showing the Swagger UI | Self-documenting API |
| 9 | 2 s | Final card: "Self-hosted WhatsApp API gateway · MIT · github.com/ribato22/MultiWA" | Call to action without marketing fluff |

Optional B-roll if you have time left over: the Visual Flow Builder
(`/automation`), the Broadcast view, and a webhook log entry.

---

## Sanitation Rules (mandatory before publishing)

Every frame must be reviewed against the list below. If any item is
visible, re-record or post-process to blur/redact.

- **Phone numbers.** Mask the middle digits of any phone number that
  appears in the dashboard, in webhook payloads, or in the WhatsApp
  client. Format like `+62-812-***-***-789`. Never publish a real phone
  number, even a throwaway one.
- **QR codes.** The QR is a credential. After the scan completes in shot
  5, freeze that frame and **blur the QR pixels**. Never publish the raw
  QR.
- **JWT, API keys, refresh tokens.** Crop or blur the network panel,
  Authorization headers, and any `apiKey`/`x-api-key` fields. Use
  obvious placeholders like `Bearer eyJ***` in voiced-over reproductions.
- **Internal hostnames and IPs.** Do not show any domain other than
  `localhost` or `example.com`. No `*.plnbatam.com`, no RFC1918 IPs, no
  internal admin URLs. The capture stack must run from `localhost`.
- **Customer or organization data.** No real customer names, no real
  contact entries, no real conversation history. Seed the dashboard with
  fake names (`Acme QA`, `Demo Customer`) before recording.
- **Email and personal identifiers.** Use `demo@example.com` for the
  sign-up step. Do not log in with a real account.
- **Browser bookmarks and recent tabs.** Use an empty profile. No tab
  group should be visible.
- **Terminal prompt.** Set `PS1='$ '` or use a generic prompt so the
  recording does not leak hostnames or working directory paths.
- **Notification badges.** Turn off macOS/Windows desktop notifications
  for the duration of the recording.

If any frame fails this checklist, the recording does not ship.

---

## File Layout and Naming

The repository does **not** currently ship a real demo recording. When a
real sanitized demo is recorded, save the asset under
`docs/screenshots/` using a release-tagged name, for example:

```
docs/screenshots/demo-v1.0.webp   # Primary asset (small, embeddable in README).
docs/screenshots/demo-v1.0.mp4    # Optional higher-fidelity video copy.
docs/screenshots/demo-v1.0.gif    # Optional GIF copy at < 8 MB for inline display.
```

Choose one canonical filename for the release and reference it from the
README under Screenshots. Re-embed only after the file is small enough
to render on github.com without timing out (target: under 8 MB for
inline display; link out for larger assets).

Do **not** ship placeholder or work-in-progress recordings as committed
assets. If a recording does not pass the sanitation checklist below, do
not check it in.

---

## Where to Show the Demo

Once published, the demo can be referenced from:

- `README.md` (root): inline below the Quick Start, or under Screenshots.
- `docs/README.md` (Getting Started section).
- The GitHub release notes for the version it lands in.

Do not embed in any file that is internal-only (`findings.md`,
`progress.md`, `task_plan.md`, `gemini.md`, internal SOPs).

---

## What Not To Do

- Do not record from any internal server, jump host, or
  `*.plnbatam.com` host. The MultiWA repository is the public face of the
  project; the internal PLN Batam deployment is separate by policy.
- Do not screenshot a session that has any of the redacted items above
  still visible "just for context."
- Do not use stock-looking marketing voiceover. Captioned text on screen
  is preferred for accessibility and to keep the demo language-neutral.
- Do not pad runtime with logo animations. The full clip should stay
  under 60 seconds.
