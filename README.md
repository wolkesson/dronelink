# DroneLink

A drone command-and-control (C2) and video link system.

See [`ARCHITECTURE.md`](./ARCHITECTURE.md) for the full system design, package boundaries, and phased development plan.

---

## Current phase

**Phase 1 is complete.** The real FC → WebRTC → TCP bridge path works end-to-end over both LAN and Tailscale.

**Phase 2 spikes 1–2 are complete.** The air-side camera picker/live preview, ground-side video recording, and live video GUI are available without changing the protocol-agnostic byte relay.

**Phase 2.5 spikes 1–2 are complete** (WebView shell + localhost PWA host, camera/mic permission passthrough); spike 3 (foreground service, wake lock, autostart) is in progress. See [`android-shell/spikes/`](./android-shell/spikes/) for individual task briefs and device-testing notes.

---

## Workspace layout

```text
apps/
  ground-core-node/    # headless signaling host + TCP bridge runtime
  ground-web-client/   # ground-side live video GUI composition
  air-webapp/          # air-side PWA composition shell
packages/
  core-transport/      # pairing/token protocol, TLS helpers, shared transport primitives
  ground-client-sdk/   # ground-side signaling/WebRTC/TCP-bridge runtime logic
  air-client-sdk/      # air-side pairing/session/serial transport logic
  ui-kit-shared/       # cross-side UI-facing presentation helpers
  ui-kit-ground/       # ground-only UI-facing scaffold
protocol/              # schemas, fixtures, wire-format docs
android-shell/         # Phase 2.5+, do not touch yet (spikes/ has task briefs)
bridge-firmware/       # future work, do not touch yet
```

### Dependency direction

- `packages/core-transport` contains shared, non-app transport primitives.
- `packages/ground-client-sdk` and `packages/air-client-sdk` depend on `packages/core-transport`.
- `packages/ui-kit-shared` and `packages/ui-kit-ground` stay presentation-only and do not reach into SDK internals.
- `apps/*` compose packages; business logic should not live directly in app packages.

The split is by **concern**, not simply by ground vs air. Shared transport/pairing logic lives in reusable packages so the ground and air shells stay thin as more UI surfaces are added.

---

## Getting started (Phase 1 / Phase 2 desktop workflow)

**Prerequisites:** Node.js 22+, npm, desktop Chrome, `mkcert`.

One-time TLS setup (per machine):

```sh
mkcert -install
```

Install workspace dependencies once from the repo root:

```sh
npm install
```

Run the ground-side headless process:

```sh
npm start --workspace @dronelink/ground-core-node
```

Run the air-side web app:

```sh
npm run dev --workspace @dronelink/air-webapp
```

1. Open `https://localhost:5173` in desktop Chrome.
2. Paste the pairing bundle printed by `@dronelink/ground-core-node` (or scan its QR code) and click **Pair**.
3. Click **Connect FC** and select the FC's serial port.
4. In INAV Configurator, connect to `localhost:5761` (TCP).
5. Open the `Ground video GUI` URL printed by the ground runtime to view the incoming camera feed while it is recorded.

To run validation locally:

```sh
npm run build --workspace @dronelink/core-transport
npm run build --workspace @dronelink/ground-client-sdk
npm run build --workspace @dronelink/air-client-sdk
npm run build --workspace @dronelink/ui-kit-shared
npm run build --workspace @dronelink/ground-core-node
npm run build --workspace @dronelink/air-webapp

npm test --workspace @dronelink/core-transport
npm test --workspace @dronelink/ground-client-sdk
npm test --workspace @dronelink/air-client-sdk
npm test --workspace @dronelink/ui-kit-shared
```

---

## Running over Tailscale

Set `SIGNAL_HOST`, `SIGNAL_TLS_TARGET`, and `TLS_PROVIDER=tailscale` before starting `@dronelink/ground-core-node`. `ensureTailscaleTlsMaterial()` now lives in `packages/core-transport` and is still invoked by the ground runtime at startup.

Example:

```sh
SIGNAL_HOST=pc-a.tailxxxx.ts.net \
SIGNAL_TLS_TARGET=pc-a.tailxxxx.ts.net \
TLS_PROVIDER=tailscale \
npm start --workspace @dronelink/ground-core-node
```

The air-side app still runs locally via `npm run dev --workspace @dronelink/air-webapp` and uses the pairing bundle printed by the ground process.

---

## What not to build yet

| Component / Feature | Deferred to |
| --- | --- |
| `android-shell` foreground service / USB bridge / WebView host | Phase 2.5 — see `android-shell/spikes/` |
| `bridge-firmware` (ESP32 WiFi/BLE UART bridge for iPhone) | Future work |
| Ground-side GUI features beyond the live video viewer | Phase 2 spikes 3–4 |
| Reconnection / backoff / resilience logic | Phase 3 |
| Docker Compose / containerized deployment | Phase 4 |
| iPhone air-side app | Future work |
