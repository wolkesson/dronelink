# AGENTS.md — Agent guidance for DroneLink

This file provides orientation for AI coding agents working in this repository.

## Repository overview

DroneLink is a drone command-and-control (C2) and video link system. **Phase 1 is complete** (pairing, WebRTC data channel, and the ground-side TCP bridge tested end-to-end against a real FC over LAN and Tailscale); **Phase 2 spikes 1–2 are complete** (air-side camera selection/live preview, ground-side video recording, and a live video GUI).

**Phase 2.5 spikes 1–2 are complete** (WebView shell + localhost PWA host, camera/mic permission passthrough); spike 3 (foreground service, wake lock, autostart) is in progress. See [`android-shell/spikes/`](./android-shell/spikes/) for individual task briefs and device-testing notes (emulator vs. real hardware) per spike.

Read [`ARCHITECTURE.md`](./ARCHITECTURE.md) and [`README.md`](./README.md) before making changes.

## Workspace layout

| Path | Language | Role |
| --- | --- | --- |
| `/packages/core-transport` | TypeScript | Shared pairing/token protocol, TLS helpers, and transport primitives |
| `/packages/ground-client-sdk` | TypeScript | Ground-side signaling, WebRTC peer handling, TCP bridge, video sink runtime |
| `/packages/air-client-sdk` | TypeScript | Air-side pairing/session state, QR scanning, WebRTC relay, serial transport abstractions |
| `/packages/ui-kit-shared` | TypeScript | Shared UI-facing presentation helpers |
| `/packages/ui-kit-ground` | TypeScript | Ground-only UI-facing scaffold |
| `/apps/ground-core-node` | Node.js + TypeScript | Headless ground runtime: signaling host + relay only |
| `/apps/ground-web-client` | TypeScript + browser assets | Ground-side live video GUI composition |
| `/apps/air-webapp` | TypeScript (Vite PWA) | Air-side PWA composition shell |
| `/android-shell` | Kotlin | **Phase 2.5 in progress** (spikes 1–2 complete, spike 3 underway). Spike task briefs live in `android-shell/spikes/`. |
| `/bridge-firmware` | ESP32 | **Future work — not started** |
| `/protocol` | Docs + JSON | Wire-format docs, schemas, and recorded byte-stream fixtures |
| `.github/workflows/` | YAML | CI workflows scoped to ground-side and air-side package groups |

## Dependency direction rule

- `packages/core-transport` is the shared base layer.
- `packages/ground-client-sdk` and `packages/air-client-sdk` may depend on `packages/core-transport`, but nothing depends upward on an app.
- `packages/ui-kit-shared` and `packages/ui-kit-ground` stay presentation-only; do not import SDK internals into UI packages.
- `apps/*` should contain layout/composition only. If a byte relay, pairing, signaling, or session change is needed, it belongs in `packages/*`, not directly in an app package.

The repo is now split by **concern** rather than by ground/air so the shells remain thin while shared logic stays reusable.

## Build, lint, and test commands

Install dependencies once from the repo root:

```sh
npm install
```

### Shared and ground-side packages
```sh
npm run build --workspace @dronelink/core-transport
npm run build --workspace @dronelink/ground-client-sdk
npm run build --workspace @dronelink/ui-kit-shared
npm run build --workspace @dronelink/ui-kit-ground
npm run build --workspace @dronelink/ground-core-node
npm run build --workspace @dronelink/ground-web-client

npm test --workspace @dronelink/core-transport
npm test --workspace @dronelink/ground-client-sdk
npm test --workspace @dronelink/ui-kit-shared
```

### Air-side packages
```sh
npm run build --workspace @dronelink/core-transport
npm run build --workspace @dronelink/air-client-sdk
npm run build --workspace @dronelink/ui-kit-shared
npm run build --workspace @dronelink/air-webapp

npm test --workspace @dronelink/core-transport
npm test --workspace @dronelink/air-client-sdk
npm test --workspace @dronelink/ui-kit-shared
npm run dev --workspace @dronelink/air-webapp
```

After changing an affected package, always run its `build` and `test` commands when tests exist.

## Local TLS setup

`navigator.serial` and `getUserMedia` require a secure context.

One-time setup:
```sh
mkcert -install
```

- `@dronelink/ground-core-node` auto-issues or reuses its cert material for `localhost`, `127.0.0.1`, and `SIGNAL_TLS_TARGET` (default `localhost`).
- `@dronelink/air-webapp` uses `vite-plugin-mkcert` during `npm run dev --workspace @dronelink/air-webapp`.
- `TLS_PROVIDER=tailscale` still routes through `ensureTailscaleTlsMaterial()` in `packages/core-transport`.

## CI

CI is path-scoped to package groups:
- `ground-ci.yml` triggers on changes under `apps/ground-core-node`, `apps/ground-web-client`, `packages/core-transport`, `packages/ground-client-sdk`, `packages/ui-kit-ground`, `packages/ui-kit-shared`, and `protocol`.
- `webapp-ci.yml` triggers on changes under `apps/air-webapp`, `packages/core-transport`, `packages/air-client-sdk`, `packages/ui-kit-shared`, and `protocol`.
- `android-ci.yml` triggers on changes under `android-shell`, `apps/air-webapp`, `packages/core-transport`, `packages/air-client-sdk`, `packages/ui-kit-shared`, and `protocol`.

`ground-ci.yml` and `webapp-ci.yml` run `npm ci` at the repo root, then the relevant workspace build/test commands; lint is advisory with `continue-on-error: true`. `android-ci.yml` runs `npm ci` and builds the `air-webapp` PWA bundle, then builds `android-shell`'s debug APK with Gradle (JDK 17) and uploads it as a workflow artifact — no test/lint step yet, since `android-shell` has no unit tests.

## Key design constraints

- **No protocol parsing in shared transport layers.** Serial data stays opaque end-to-end. MSP/MAVLink parsing belongs in ground-specific higher layers only.
- **Keep `SerialTransport` behind the air SDK abstraction.** Desktop Chrome uses `WebSerialTransport`; Android WebView later uses `NativeBridgeTransport`.
- **Signaling stays inside the ground runtime.** There is no separate signaling service.
- **TLS trust is still out-of-band.** Do not add in-browser cert pinning.

## What not to build yet

Do not start these until their planned phases:

| Component / Feature | Deferred to |
| --- | --- |
| `/android-shell` (foreground service, USB bridge, WebView host) | Phase 2.5 — see `android-shell/spikes/` for the five-spike breakdown |
| `/bridge-firmware` (ESP32 WiFi/BLE UART bridge for iPhone) | Future work |
| Ground-side GUI features beyond the live video viewer | Phase 2 spikes 3–4 |
| Reconnection / backoff / resilience | Phase 3 |
| Docker Compose / containerized deployment | Phase 4 |
| iPhone air-side app | Future work |

## Testing approach

- Unit tests live alongside source files (`*.test.ts`).
- `packages/ground-client-sdk`, `packages/air-client-sdk`, `packages/core-transport`, and `packages/ui-kit-shared` use `vitest` in Node.
- Protocol contract tests use `/protocol` schemas and fixtures.
- Do not remove or disable existing tests.

## Code style

- TypeScript throughout; strict mode is enabled.
- Use existing libraries where possible.
- Do not add comments unless they clarify non-obvious logic or match the surrounding style.

## Markdown style (AGENTS.md, ARCHITECTURE.md, README.md)

- **Table formatting:** Always use spaces around table pipes: `| Header | Header |` not `|Header|Header|`.
  Separator rows must also have spaces: `| --- | --- |` not `|---|---|`.
  This ensures consistent MD060 compliance (markdownlint table-column-style rule).
- Before committing markdown changes, run `npx markdownlint-cli2 README.md ARCHITECTURE.md AGENTS.md` to verify.
