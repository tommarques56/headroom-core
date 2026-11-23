# Headroom Core - local LLM token-cost compression for Claude Code & friends

Fork of [gglucass/headroom-desktop](https://github.com/gglucass/headroom-desktop)
(MIT), trimmed to the core product and wired to a self-hosted backend.

## What this build is

A macOS menu-bar (tray) app that cuts the token costs of Claude Code, ChatGPT
Codex, OpenCode and Grok Build by ~50%. It routes the clients through a local
two-hop proxy (`127.0.0.1:6767` -> managed Python `headroom-ai` engine) that
reversibly compresses tool outputs, logs, JSON and conversation history before
each API call. Originals stay cached locally and retrievable.

## What was removed vs upstream

All opt-in addons and their installer plumbing are gone from the catalog,
launch wiring, Tauri commands and GUI:

- rtk (shell-command proxy), markitdown, serena, codebase-memory, context7 (MCP servers)
- ponytail, caveman, chisle (behavior plugins)
- The GUI "Addons" tab

What remains: the compression engine (`headroom-ai`, Apache-2.0 pinned wheel),
the 4-client detection/routing with backup+rollback, the savings dashboard,
activity feed, onboarding, updater, and the full pricing/auth flow - now
pointed at a self-hosted gateway instead of the upstream's private backend.

## The self-hosted account backend (Supabase + Docker)

```bash
cd backend
docker compose up -d
# gateway on http://127.0.0.1:8090, Postgres inside
```

The gateway (`backend/gateway/server.mjs`) implements the desktop API contract:
email-code sign-in, 30-day bearer sessions, 7-day trial, config. During local
development the sign-in code is printed to the gateway logs:

```bash
docker compose logs gateway | grep AUTH-CODE
```

The desktop app points at `http://127.0.0.1:8090/api/v1` by default (see
`DEFAULT_ACCOUNT_API_BASE_URL` in `src-tauri/src/pricing.rs`). Change that
constant - or the `HEADROOM_ACCOUNT_API_BASE_URL` build env - to your deployed
URL before shipping.

## Development

```bash
npm install
npm run tauri dev        # runs the app (debug; honors HEADROOM_ACCOUNT_API_BASE_URL)
npx tsc --noEmit         # frontend types
npx vitest run           # frontend tests
cargo test --manifest-path src-tauri/Cargo.toml --lib -- --skip against_the_installed_wheel
```

## Building the macOS app

CI builds the universal DMG on every tag (`v*`) and manual dispatch:
`.github/workflows/release-macos-core.yml`. Locally:

```bash
npm run tauri build -- --target universal-apple-darwin
```

The build is ad-hoc signed (no Apple Developer ID yet). To ship signed and
notarized builds, set the `APPLE_*` secrets and add the signing env to the
workflow.

## Licensing

- This fork: MIT (upstream's license, © Garm Tech BV, retained).
- `headroom-ai` engine: Apache-2.0, pinned wheel, NOTICE retained.
- Upstream project: https://github.com/gglucass/headroom-desktop
