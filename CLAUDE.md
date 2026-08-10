# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project

DroneLink is a drone command-and-control (C2) and video link system: the air side reads FC telemetry/control over USB serial and captures phone/desktop camera media, forwarding both to the ground over WebRTC; the ground side terminates signaling/WebRTC, bridges the serial byte stream to TCP for INAV Configurator/GCS, and records or re-serves video. The byte path stays protocol-agnostic end-to-end (no MSP/MAVLink parsing in shared transport layers).

Read [ARCHITECTURE.md](ARCHITECTURE.md) for the full system design and phased plan before making structural changes.

**Phase 1 is complete** (pairing, WebRTC data channel, ground-side TCP bridge, tested end-to-end over LAN and Tailscale). **Phase 2 spikes 1–2 are complete** (air-side camera selection/live preview, ground-side video recording, live video GUI).

## Workspace layout

This is an npm workspaces monorepo (`apps/*`, `packages/*`).

| Path | Language | Role |
| --- | --- | --- |
| `packages/core-transport` | TypeScript | Shared pairing/token protocol, TLS helpers (mkcert/Tailscale), transport primitives |
| `packages/ground-client-sdk` | TypeScript | Ground-side signaling server, WebRTC peer, TCP bridge, video sink runtime |
| `packages/air-client-sdk` | TypeScript | Air-side pairing/session state, QR scanning, WebRTC relay, serial transport abstractions |
| `packages/ui-kit-shared` | TypeScript | Shared UI-facing presentation helpers |
| `packages/ui-kit-ground` | TypeScript | Ground-only UI-facing scaffold |
| `apps/ground-core-node` | Node.js + TypeScript | Headless ground runtime: composes `ground-client-sdk` only (signaling host + relay) |
| `apps/ground-web-client` | TypeScript + browser | Ground-side live video GUI composition |
| `apps/air-webapp` | TypeScript (Vite PWA) | Air-side PWA composition shell |
| `protocol/` | Docs + JSON | Wire-format docs, signaling JSON schemas, recorded byte-stream fixtures |
| `android-shell/` | Kotlin | **Not started — do not touch until Phase 2.5** |
| `bridge-firmware/` | ESP32 | **Future work — not started** |

### Dependency direction (enforced by convention, not tooling)

- `packages/core-transport` is the shared base layer that everything else may depend on.
- `packages/ground-client-sdk` and `packages/air-client-sdk` depend on `core-transport`; nothing depends upward on an app.
- `packages/ui-kit-shared` and `packages/ui-kit-ground` stay presentation-only — never import SDK internals into them.
- `apps/*` are layout/composition only. Byte relay, pairing, signaling, or session logic belongs in `packages/*`, not in an app.

The repo is split by **concern** (transport vs. SDK vs. UI vs. app shell), not simply by ground vs. air, so shared logic stays reusable as more surfaces are added.

## Commands

Install once from the repo root:

```sh
npm install
```

Per-package scripts (run from repo root via `--workspace`, or `cd` into the package):

```sh
npm run build --workspace @dronelink/<pkg>   # tsc --noEmit (air-webapp also runs vite build)
npm run lint  --workspace @dronelink/<pkg>   # eslint src --ext .ts[,.tsx]
npm test      --workspace @dronelink/<pkg>   # vitest run (core-transport, ground-client-sdk, air-client-sdk, ui-kit-shared only)
```

Run a single test file with vitest directly, e.g.:

```sh
npx vitest run src/node-tls.test.ts --workspace packages/core-transport
```

(or `cd packages/core-transport && npx vitest run src/node-tls.test.ts`)

Run everything relevant to a change — always build and test every package you touched **and** anything that depends on it:

```sh
# shared + ground-side
npm run build --workspace @dronelink/core-transport
npm run build --workspace @dronelink/ground-client-sdk
npm run build --workspace @dronelink/ui-kit-shared
npm run build --workspace @dronelink/ui-kit-ground
npm run build --workspace @dronelink/ground-core-node
npm run build --workspace @dronelink/ground-web-client
npm test --workspace @dronelink/core-transport
npm test --workspace @dronelink/ground-client-sdk
npm test --workspace @dronelink/ui-kit-shared

# air-side
npm run build --workspace @dronelink/core-transport
npm run build --workspace @dronelink/air-client-sdk
npm run build --workspace @dronelink/ui-kit-shared
npm run build --workspace @dronelink/air-webapp
npm test --workspace @dronelink/core-transport
npm test --workspace @dronelink/air-client-sdk
npm test --workspace @dronelink/ui-kit-shared
```

Markdown lint (README.md, ARCHITECTURE.md, AGENTS.md):

```sh
npm run lint:md
```

### Running the app locally

Prerequisites: Node.js 22+, npm, desktop Chrome, `mkcert` (one-time `mkcert -install`; `navigator.serial` and `getUserMedia` both require a secure context).

```sh
npm start --workspace @dronelink/ground-core-node   # ground-side headless process
npm run dev --workspace @dronelink/air-webapp        # air-side web app (https://localhost:5173)
```

Then: open the air-webapp URL in desktop Chrome, paste/scan the pairing bundle printed by `ground-core-node` and click **Pair**, click **Connect FC** and pick the serial port, connect INAV Configurator to `localhost:5761` (TCP), and open the ground runtime's printed `Ground video GUI` URL to view the recorded feed.

For Tailscale instead of LAN, set `SIGNAL_HOST`, `SIGNAL_TLS_TARGET`, and `TLS_PROVIDER=tailscale` before starting `ground-core-node` — this routes through `ensureTailscaleTlsMaterial()` in `packages/core-transport`.

## Key design constraints

- **No protocol parsing in shared transport layers.** Serial data stays opaque end-to-end; MSP/MAVLink parsing belongs only in ground-specific higher layers.
- **`SerialTransport` stays behind the air SDK abstraction.** Desktop Chrome uses `WebSerialTransport`; Android WebView will later use `NativeBridgeTransport` (Phase 2.5).
- **Signaling stays inside the ground runtime.** There is no separate signaling service.
- **TLS trust stays out-of-band.** Do not add in-browser cert pinning; `mkcert` or Tailscale-issued certs are the only supported trust paths.

## What not to build yet

| Component / Feature | Deferred to |
| --- | --- |
| `android-shell` (foreground service, USB bridge, WebView host) | Phase 2.5 |
| `bridge-firmware` (ESP32 WiFi/BLE UART bridge for iPhone) | Future work |
| Ground-side GUI features beyond the live video viewer | Phase 2 spikes 3–4 |
| Reconnection / backoff / resilience logic | Phase 3 |
| Docker Compose / containerized deployment | Phase 4 |
| iPhone air-side app | Future work |

## Testing

- Unit tests live alongside source files (`*.test.ts`), run with `vitest`.
- `protocol/` holds the shared contract: `schemas/` (JSON Schema, draft-07, for signaling messages incl. the pairing bundle) and `fixtures/` (recorded raw serial byte-stream captures, each <1 MB with an accompanying `.json` metadata file). Both ground and air test suites validate against these instead of needing a real FC or SITL.
- Do not remove or disable existing tests.
- After changing a package, always run its `build` and `test` commands (and those of dependents) — see Commands above.

## CI

Path-scoped GitHub Actions, both running root `npm ci` then the relevant workspace build/test commands (lint is advisory, `continue-on-error: true`):

- `ground-ci.yml` — triggers on `apps/ground-core-node`, `apps/ground-web-client`, `packages/core-transport`, `packages/ground-client-sdk`, `packages/ui-kit-ground`, `packages/ui-kit-shared`, `protocol`.
- `webapp-ci.yml` — triggers on `apps/air-webapp`, `packages/core-transport`, `packages/air-client-sdk`, `packages/ui-kit-shared`, `protocol`.
- `android-ci.yml` — triggers on `android-shell`, `apps/air-webapp`, `packages/core-transport`, `packages/air-client-sdk`, `packages/ui-kit-shared`, `protocol`. Builds the `air-webapp` PWA bundle via `npm ci`, then builds `android-shell`'s debug APK with Gradle (JDK 17) and uploads it as a workflow artifact. No lint/test step yet — `android-shell` has no unit tests.

## Code style

- TypeScript throughout, strict mode enabled.
- Prefer existing libraries already in the dependency tree over adding new ones.
- No comments unless they clarify non-obvious logic.

## Markdown style (for README.md / ARCHITECTURE.md / AGENTS.md)

- Always use spaces around table pipes (`| Header | Header |`, `| --- | --- |`) for MD060 compliance.
- Verify with `npm run lint:md` before committing markdown changes.
