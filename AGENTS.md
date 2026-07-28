# AGENTS.md — Agent guidance for DroneLink

This file provides orientation for AI coding agents (GitHub Copilot, Claude Code, etc.) working in this repository.

## Repository overview

DroneLink is a drone command-and-control (C2) and video link system. It is a TypeScript/Node.js monorepo currently in **Phase 0 (spikes)**. Read [`ARCHITECTURE.md`](./ARCHITECTURE.md) and [`README.md`](./README.md) before making any changes.

## Monorepo layout

| Directory | Language | Role |
|---|---|---|
| `/ground` | Node.js + TypeScript | Signaling server, WebRTC peer (`werift`), byte-stream↔TCP bridge, video sink |
| `/webapp` | TypeScript (Vite PWA) | All air-side logic: pairing, WebRTC session, serial byte relay, UI |
| `/webapp/src/core` | TypeScript | Transport-agnostic: pairing, session state machine, WebRTC relay logic |
| `/webapp/src/transport` | TypeScript | `SerialTransport` interface + `WebSerialTransport` and `NativeBridgeTransport` implementations |
| `/webapp/src/ui` | TypeScript | UI components |
| `/android-shell` | Kotlin | **Not started — do not touch until Phase 2.5** |
| `/bridge-firmware` | ESP32 | **Future work — not started** |
| `/protocol` | Docs + JSON | Wire-format docs, JSON schemas, recorded byte-stream fixtures |
| `.github/workflows/` | YAML | CI: `ground-ci.yml`, `webapp-ci.yml` |

## Build, lint, and test commands

All commands must be run from the package's subdirectory (not the repo root).

### `/ground`
```sh
cd ground
npm install      # install deps
npm run build    # TypeScript type-check (tsc --noEmit)
npm run lint     # ESLint (advisory — continue-on-error in CI)
npm test         # vitest run
npm start        # run the signaling server
```

### `/webapp`
```sh
cd webapp
npm install      # install deps
npm run build    # tsc --noEmit + vite build
npm run lint     # ESLint (advisory — continue-on-error in CI)
npm test         # vitest run
npm run dev      # Vite dev server at https://localhost:5173 (requires mkcert)
```

After making changes to `/ground` or `/webapp`, always run `npm run build` and `npm test` for the affected package.

## Local TLS setup (required for dev)

`navigator.serial` and `getUserMedia` require a secure context. Both packages use `mkcert`-issued certs for local development.

One-time setup (per machine):
```sh
mkcert -install
```

- `/ground`: on first start the server auto-issues its cert via `mkcert` for `localhost`, `127.0.0.1`, and `SIGNAL_TLS_TARGET` (env var, defaults to `localhost`).
- `/webapp`: `vite-plugin-mkcert` is wired into `vite.config.ts` and handles cert issuance automatically when `npm run dev` is run.

## CI

CI is path-scoped — workflows only run when files in the corresponding package directory change:
- `ground-ci.yml` triggers on `ground/**` changes.
- `webapp-ci.yml` triggers on `webapp/**` changes.

Each workflow runs: `npm ci` → `npm run build` → `npm run lint` (advisory) → `npm test`.

When modifying CI workflows, preserve the path filters and the advisory `continue-on-error: true` on lint steps.

## Key design constraints

- **No protocol parsing.** Serial data is forwarded as an opaque byte stream end-to-end. Never add MSP/MAVLink parsing to `/ground` or `/webapp`. Protocol choice is an FC/GCS configuration matter.
- **`SerialTransport` abstraction.** All serial I/O in `/webapp` goes through the `SerialTransport` interface. `WebSerialTransport` is the desktop Chrome implementation. `NativeBridgeTransport` (Android WebView) communicates over a `WebMessageChannel`. Do not bypass this interface.
- **Signaling is inside `/ground`.** There is no separate signaling service. Keep it that way.
- **TLS cert pinning is not implementable in browser JS.** The token exchange after the WebSocket connects is the real authorization gate in Phase 0–2. Certificate pinning becomes feasible in Phase 2.5 inside the Android native shell.

## What NOT to build yet

Do not start these — they are explicitly deferred:

| Component / Feature | Deferred to |
|---|---|
| `/android-shell` (Kotlin foreground service, USB bridge, WebView host) | Phase 2.5 |
| `/bridge-firmware` (ESP32 WiFi/BLE UART bridge for iPhone) | Future work |
| Video capture and forwarding | Phase 2 |
| Reconnection / backoff / resilience | Phase 3 |
| Docker Compose / containerized deployment | Phase 4 |
| iPhone air-side app | Future work (after bridge firmware) |
| Protocol-aware channel prioritization | Future work |

## Current work (Phase 0 spikes)

The three spikes to complete are:
1. **Pairing spike** — generate a QR/token bundle in `/ground`, scan/parse it in `/webapp`, complete a token-authenticated `wss://` handshake.
2. **Serial spike** — open the real FC's COM port via `navigator.serial` (`WebSerialTransport`) in desktop Chrome, read raw bytes.
3. **Bridge spike** — pipe a recorded byte stream from `/protocol/fixtures` into a local TCP socket, confirm INAV Configurator connects and parses it.

All three spikes run with `/ground` + `/webapp` in desktop Chrome only. No Android phone or native code is needed.

## Testing approach

- Unit tests live alongside source files (`*.test.ts`).
- `/webapp/src/core` and `/webapp/src/transport` have their own unit tests; these run with `vitest` in Node (no browser required).
- Protocol contract tests in both packages use fixtures from `/protocol/fixtures`.
- INAV SITL integration is stubbed in `ground-ci.yml` but not yet enabled — do not enable it until the SITL image and integration tests exist.
- Do not remove or disable existing tests. Do not add new testing frameworks.

## Code style

- TypeScript throughout; strict mode enabled in both packages.
- ESLint with `@typescript-eslint` in both packages (config is still being finalized — lint failures are advisory in CI).
- No comments unless they clarify non-obvious logic or match existing comment style in the file.
- Use existing libraries. Do not add new dependencies without a clear need.
