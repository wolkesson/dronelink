# AGENTS.md — Agent guidance for DroneLink

This file provides orientation for AI coding agents (GitHub Copilot, Claude Code, etc.) working in this repository.

## Repository overview

DroneLink is a drone command-and-control (C2) and video link system. **Phase 1 is complete** (pairing, WebRTC data channel, and ground-side TCP bridge tested end-to-end against a real FC over LAN and Tailscale); **Phase 2 spike 1 is in progress** (air-side camera source selection, live preview, ground-side video recording). Read [`ARCHITECTURE.md`](./ARCHITECTURE.md) and [`README.md`](./README.md) before making any changes.

## Monorepo layout

| Directory | Language | Role |
|---|---|---|
| `/ground` | Node.js + TypeScript | Signaling server, WebRTC peer (`werift`), byte-stream↔TCP bridge, video sink |
| `/ground/src/pairing.ts` | TypeScript | TLS material (mkcert / Tailscale), token/bundle types and validation |
| `/ground/src/signaling.ts` | TypeScript | HTTPS/WSS server factory, token auth gate, forwards signaling messages to `webrtc.ts` |
| `/ground/src/webrtc.ts` | TypeScript | `RTCPeerConnection` lifecycle, offer/answer/ICE, data-channel callbacks |
| `/ground/src/tcp-bridge.ts` | TypeScript | TCP server, one-client limit, bidirectional relay between TCP and the WebRTC data channel |
| `/webapp` | TypeScript (Vite PWA) | All air-side logic: pairing, WebRTC session, serial byte relay, UI |
| `/webapp/src/core` | TypeScript | Transport-agnostic: pairing, session state machine, WebRTC relay logic |
| `/webapp/src/core/WebRtcSessionManager.ts` | TypeScript | WebRTC session state machine: offer/answer/ICE exchange, data-channel relay to `SerialTransport` |
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
- **TLS cert pinning is not implementable in browser JS.** Two TLS paths exist: (1) `mkcert` issues a local-CA cert trusted via `mkcert -install` — browser accepts it after a one-time per-machine install, no click-through warning; (2) `TLS_PROVIDER=tailscale` obtains a real Let's Encrypt cert via `tailscale cert` — publicly trusted, no `mkcert` needed on either machine. In both cases the browser has no API to inspect or pin the certificate before the page script runs. The token exchange after the WebSocket connects is the real, enforceable app-level authorization gate in Phase 0–2. Certificate pinning becomes feasible in Phase 2.5 inside the Android native shell.

## What NOT to build yet

Do not start these — they are explicitly deferred:

| Component / Feature | Deferred to |
|---|---|
| `/android-shell` (Kotlin foreground service, USB bridge, WebView host) | Phase 2.5 |
| `/bridge-firmware` (ESP32 WiFi/BLE UART bridge for iPhone) | Future work |
| Video capture and forwarding — ground-side GUI (spike 2+) | Phase 2, spikes 2–4 |
| Reconnection / backoff / resilience | Phase 3 |
| Docker Compose / containerized deployment | Phase 4 |
| iPhone air-side app | Future work (after bridge firmware) |
| Protocol-aware channel prioritization | Future work |

## Phase 2 spike 1 in progress — spikes 2–4 upcoming

Phase 1 delivered the thin end-to-end pipe: pairing, WebRTC data channel, and the ground-side TCP bridge are implemented and working end-to-end against a real FC over both LAN and Tailscale. The Phase 0 spikes (pairing, serial, bridge) are fully subsumed into Phase 1.

Phase 2 adds the video track in four spikes (see **Phase 2** in [`ARCHITECTURE.md`](./ARCHITECTURE.md)):
- **Spike 1 (in progress):** Air-side camera source selection (picker + "No video" option), live preview, camera reused for QR scanning when selected; ground records the received video track to a `.webm` file for manual verification.
- **Spike 2 (upcoming):** Ground-side web GUI displaying video live via a local loopback WebRTC connection.
- **Spikes 3–4 (future, not yet scoped):** External retransmission; image processing.

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
