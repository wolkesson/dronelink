# DroneLink — Architecture & Development Plan

Status: draft v3

## 1. Goals & constraints

- Air side reads FC telemetry/control over USB serial and captures phone/desktop camera media, forwarding both to the ground over WebRTC.
- Ground side terminates signaling/WebRTC, bridges the serial byte stream to TCP for INAV Configurator/GCS, and records or re-serves video.
- The byte path remains protocol-agnostic end-to-end.
- The repository is split by **concern**, not only by ground vs air, so shared transport and pairing logic live below thin app shells.

## 2. Package graph

```text
packages/
  core-transport/
    pairing/token protocol
    TLS material helpers (mkcert / Tailscale)
    shared transport primitives
  ground-client-sdk/
    signaling server
    ground-side WebRTC peer
    TCP bridge
    video sink runtime
  air-client-sdk/
    pairing session client
    QR scanner
    browser WebRTC session manager
    serial transport abstractions
  ui-kit-shared/
    shared UI-facing presentation helpers
  ui-kit-ground/
    ground-only UI-facing scaffold

apps/
  ground-core-node/
    headless runtime that composes ground-client-sdk only
  ground-web-client/
    ground UI composition scaffold
  air-webapp/
    air-side PWA composition shell
```

### Dependency direction rule

- `core-transport` is the base layer.
- `ground-client-sdk` and `air-client-sdk` depend on `core-transport`.
- `ui-kit-shared` and `ui-kit-ground` stay presentation-only and do not import SDK internals.
- `apps/*` compose packages and should not own business logic.

This mirrors the Android-shell principle: keep shells thin and keep durable logic in shared layers.

## 3. Key design decisions

- **Signaling remains part of the ground runtime.** No separate signaling deployment.
- **Pairing/authentication stays QR/manual token based.** The WebSocket token exchange is the enforceable authorization gate.
- **TLS trust remains out-of-band.** `mkcert` or Tailscale-issued certs are still the supported trust paths; browser-side cert pinning is still not possible.
- **Byte relay stays protocol-agnostic.** MSP/MAVLink parsing does not belong in `core-transport`.
- **Air serial access remains abstracted.** `WebSerialTransport` is the current desktop implementation; `NativeBridgeTransport` remains the Android WebView path for Phase 2.5.

## 4. Runtime mapping

| Runtime | Packages composed |
|---|---|
| `@dronelink/ground-core-node` | `@dronelink/core-transport`, `@dronelink/ground-client-sdk` |
| `@dronelink/air-webapp` | `@dronelink/core-transport`, `@dronelink/air-client-sdk`, `@dronelink/ui-kit-shared` |
| `@dronelink/ground-web-client` | `@dronelink/core-transport`, `@dronelink/ground-client-sdk`, `@dronelink/ui-kit-shared`, `@dronelink/ui-kit-ground` |

## 5. Development and CI

- The repo root is an npm workspace containing `apps/*` and `packages/*`.
- `ground-ci.yml` runs root `npm ci`, then builds/tests the ground-side and shared workspaces.
- `webapp-ci.yml` runs root `npm ci`, then builds/tests the air-side and shared workspaces.
- Lint remains advisory in both workflows.
- Local development TLS still uses `mkcert` for the air app and either `mkcert` or `tailscale cert` for the ground runtime.

## 6. Current implementation state

### Complete
- Phase 0 pairing/token flow
- Phase 1 thin end-to-end FC → WebRTC → TCP bridge path
- Workspace extraction of shared transport, air SDK, ground SDK, and app shells
- Phase 2 spikes 1–2: air-side camera source selection/live preview, ground-side video recording, and the live video GUI

### Deferred
- Ground-side GUI features beyond the live video viewer
- Android native shell work until Phase 2.5
- ESP32 bridge firmware and iPhone air-side support
- Reconnection/resilience work
- Docker/deployment work

## 7. Validation checklist

- `@dronelink/ground-core-node` starts standalone and resolves TLS material through `core-transport`.
- Existing pairing QR/token flow stays unchanged.
- Existing Phase 1 relay path remains protocol-agnostic.
- `TLS_PROVIDER=tailscale` still flows through `ensureTailscaleTlsMaterial()` at startup.
- Cert/key files remain ignored.
