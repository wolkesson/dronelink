# DroneLink

A drone command-and-control (C2) and video link system.

See [`ARCHITECTURE.md`](./ARCHITECTURE.md) for the full system design, package boundaries, and phased development plan.

---

## Current phase

**Phase 1 is complete.** The real FC → WebRTC → TCP bridge path works end-to-end over both LAN and Tailscale.

**Phase 2 spike 1 is in progress.** Current work adds air-side camera selection/live preview and ground-side video recording without changing the protocol-agnostic byte relay.

---

## Workspace layout

```text
apps/
  ground-core-node/    # headless signaling host + TCP bridge runtime
  ground-web-client/   # ground-side UI composition scaffold
  air-webapp/          # air-side PWA composition shell
packages/
  core-transport/      # pairing/token protocol, TLS helpers, shared transport primitives
  ground-client-sdk/   # ground-side signaling/WebRTC/TCP-bridge runtime logic
  air-client-sdk/      # air-side pairing/session/serial transport logic
  ui-kit-shared/       # cross-side UI-facing presentation helpers
  ui-kit-ground/       # ground-only UI-facing scaffold
protocol/              # schemas, fixtures, wire-format docs
android-shell/         # Phase 2.5+, do not touch yet
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
|---|---|
| `android-shell` foreground service / USB bridge / WebView host | Phase 2.5 |
| `bridge-firmware` (ESP32 WiFi/BLE UART bridge for iPhone) | Future work |
| Ground-side live video GUI beyond the composition scaffold | Phase 2 spikes 2–4 |
| Reconnection / backoff / resilience logic | Phase 3 |
| Docker Compose / containerized deployment | Phase 4 |
| iPhone air-side app | Future work |
