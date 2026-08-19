# AGENTS.md — Agent guidance for DroneLink

This file provides orientation for AI coding agents working in this repository, including Claude Code — see [`CLAUDE.md`](./CLAUDE.md), which points back here.

## Repository overview

DroneLink is a drone command-and-control (C2) and video link system: pairing, the WebRTC data channel, and the ground-side TCP bridge are tested end-to-end against a real FC over LAN and Tailscale; the air-side camera picker/live preview, ground-side video recording, and live video GUI are in place; and `android-shell` (WebView shell + localhost PWA host, camera/mic permission passthrough, foreground service/wake lock/autostart, USB host serial bridge) has been validated end-to-end on real hardware — unattended reboot autostart, the FC/camera/WebRTC pipeline, ground pairing, INAV Configurator over the TCP bridge, and a 45+ minute soak session.

Read [`ARCHITECTURE.md`](./ARCHITECTURE.md) and [`README.md`](./README.md) before making changes; see `ARCHITECTURE.md`'s "Current implementation state" for the full breakdown and known limitations, and [`android-shell/README.md`](./android-shell/README.md) for Android-specific setup and device-testing notes.

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
| `android-shell/` | Kotlin | Native Android WebView shell: USB serial bridge, camera/mic passthrough, foreground service/autostart. See `android-shell/README.md`. |
| `bridge-firmware/` | ESP32 | **Future work — not started** |
| `.github/workflows/` | YAML | CI workflows scoped to ground-side and air-side package groups |

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
npm run build          --workspace @dronelink/<pkg>   # tsc --noEmit (air-webapp also runs vite build)
npm run lint           --workspace @dronelink/<pkg>   # eslint src --ext .ts[,.tsx]
npm test               --workspace @dronelink/<pkg>   # vitest run (core-transport, ground-client-sdk, air-client-sdk, ui-kit-shared only)
npm run test:coverage  --workspace @dronelink/<pkg>   # vitest run --coverage (same four packages)
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

### Local TLS setup

`navigator.serial` and `getUserMedia` require a secure context.

One-time setup:

```sh
mkcert -install
```

- `@dronelink/ground-core-node` auto-issues or reuses its cert material for `localhost`, `127.0.0.1`, and `SIGNAL_TLS_TARGET` (default `localhost`).
- `@dronelink/air-webapp` uses `vite-plugin-mkcert` during `npm run dev --workspace @dronelink/air-webapp`.
- `TLS_PROVIDER=tailscale` routes through `ensureTailscaleTlsMaterial()` in `packages/core-transport`.

### Running the app locally

```sh
npm start --workspace @dronelink/ground-core-node   # ground-side headless process
npm run dev --workspace @dronelink/air-webapp        # air-side web app (https://localhost:5173)
```

Then: open the air-webapp URL in desktop Chrome, paste/scan the pairing bundle printed by `ground-core-node` and click **Pair**, click **Connect FC** and pick the serial port, connect INAV Configurator to `localhost:5761` (TCP), and open the ground runtime's printed `Ground video GUI` URL to view the recorded feed.

For Tailscale instead of LAN, set `SIGNAL_HOST`, `SIGNAL_TLS_TARGET`, and `TLS_PROVIDER=tailscale` before starting `ground-core-node`.

## Key design constraints

- **No protocol parsing in shared transport layers.** Serial data stays opaque end-to-end; MSP/MAVLink parsing belongs only in ground-specific higher layers.
- **`SerialTransport` stays behind the air SDK abstraction.** Desktop Chrome uses `WebSerialTransport`; Android WebView uses `NativeBridgeTransport`, backed by `android-shell`'s native USB bridge.
- **Signaling stays inside the ground runtime.** There is no separate signaling service.
- **TLS trust stays out-of-band.** Do not add in-browser cert pinning; `mkcert` or Tailscale-issued certs are the only supported trust paths.

## What not to build yet

- `bridge-firmware` (ESP32 WiFi/BLE UART bridge for iPhone)
- Ground-side GUI features beyond the live video viewer
- Reconnection / backoff / resilience logic
- Docker Compose / containerized deployment
- iPhone air-side app

## Testing

- Unit tests live alongside source files (`*.test.ts`), run with `vitest`.
- `protocol/` holds the shared contract: `schemas/` (JSON Schema, draft-07, for signaling messages incl. the pairing bundle) and `fixtures/` (recorded raw serial byte-stream captures, each <1 MB with an accompanying `.json` metadata file). Both ground and air test suites validate against these instead of needing a real FC or SITL.
- Do not remove or disable existing tests.
- After changing a package, always run its `build` and `test` commands (and those of dependents) — see Commands above.

## CI

Path-scoped GitHub Actions, all running root `npm ci` then the relevant workspace build/lint/test commands:

- `ground-ci.yml` — triggers on `apps/ground-core-node`, `apps/ground-web-client`, `packages/core-transport`, `packages/ground-client-sdk`, `packages/ui-kit-ground`, `packages/ui-kit-shared`, `protocol`.
- `webapp-ci.yml` — triggers on `apps/air-webapp`, `packages/core-transport`, `packages/air-client-sdk`, `packages/ui-kit-shared`, `protocol`.
- `android-ci.yml` — triggers on `android-shell`, `apps/air-webapp`, `packages/core-transport`, `packages/air-client-sdk`, `packages/ui-kit-shared`, `protocol`. Builds the `air-webapp` PWA bundle via `npm ci`, runs `android-shell`'s Kotlin unit tests (`./gradlew testDebugUnitTest`), then builds the debug APK with Gradle (JDK 17) and uploads both the test report and the APK as workflow artifacts. No lint step yet.

## Code style

- TypeScript throughout, strict mode enabled.
- Prefer existing libraries already in the dependency tree over adding new ones.
- No comments unless they clarify non-obvious logic.

## Markdown style (for README.md / ARCHITECTURE.md / AGENTS.md)

- **Table formatting:** Always use spaces around table pipes: `| Header | Header |` not `|Header|Header|`. Separator rows must also have spaces: `| --- | --- |` not `|---|---|`. This ensures consistent MD060 compliance (markdownlint table-column-style rule).
- Verify with `npm run lint:md` before committing markdown changes.
