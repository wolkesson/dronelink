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
- **Air serial access stays abstracted.** `WebSerialTransport` is the desktop implementation; `NativeBridgeTransport` is the Android WebView path, backed by `android-shell`'s native USB bridge.

## 4. Runtime mapping

| Runtime | Packages composed |
| --- | --- |
| `@dronelink/ground-core-node` | `@dronelink/core-transport`, `@dronelink/ground-client-sdk` |
| `@dronelink/air-webapp` | `@dronelink/core-transport`, `@dronelink/air-client-sdk`, `@dronelink/ui-kit-shared` |
| `@dronelink/ground-web-client` | `@dronelink/core-transport`, `@dronelink/ground-client-sdk`, `@dronelink/ui-kit-shared`, `@dronelink/ui-kit-ground` |

## 5. Development and CI

- The repo root is an npm workspace containing `apps/*` and `packages/*`.
- `ground-ci.yml` runs root `npm ci`, then builds/tests the ground-side and shared workspaces.
- `webapp-ci.yml` runs root `npm ci`, then builds/tests the air-side and shared workspaces.
- `android-ci.yml` runs root `npm ci` to build the `air-webapp` PWA bundle, runs `android-shell`'s Kotlin unit tests with Gradle (JDK 17), then builds the debug APK and uploads both the test report and the APK as workflow artifacts.
- Lint remains advisory in the npm-based workflows; `android-ci.yml` has no lint step yet (see the workflow file).
- Local development TLS still uses `mkcert` for the air app and either `mkcert` or `tailscale cert` for the ground runtime.

## 6. Current implementation state

### Complete
- Pairing/token flow and the WebRTC data channel
- End-to-end FC → WebRTC → TCP bridge path
- Workspace split into shared transport, air SDK, ground SDK, and app shells
- Air-side camera source selection/live preview, ground-side video recording, and the live video GUI
- `android-shell`: WebView shell + localhost PWA host, camera/mic permission passthrough, foreground service/wake lock/autostart, and the USB host serial bridge (`NativeBridgeTransport`) — validated end-to-end on real hardware (unattended reboot autostart, the FC/camera/WebRTC pipeline, ground pairing, INAV Configurator over the TCP bridge, and a 45+ minute soak session)

### Known limitation

`android-shell`'s USB connection is owned by `MainActivity`, not `AirShellForegroundService` — backgrounding/killing the Activity tears down the WebView (and the USB bridge) even though the service and process keep running. Moving USB ownership into the foreground service's lifecycle is not yet done; see `android-shell/README.md`.

Mid-session video source switching (`WebRtcSessionManager.replaceVideoTrack`, air-webapp's device picker while connected) swaps the outbound `MediaStreamTrack` in place via `RTCRtpSender.replaceTrack` and skips renegotiation entirely. The ground side has no way to learn about the swap: its `MediaRecorder` is sized once from the `videoWidth`/`videoHeight` signaled in the original SDP offer (`ground-client-sdk`'s `webrtc.ts`) and never re-reads dimensions afterward. Switching to a source with a different resolution mid-session will desync the recorder from the actual frame size and can corrupt the recording — only same-resolution swaps are safe today. Fixing this needs a new signaling message so the ground side can resize or restart the recorder when the source changes.

### Deferred
- Ground-side GUI features beyond the live video viewer
- ESP32 bridge firmware and iPhone air-side support
- Reconnection/resilience work
- Docker/deployment work

## 7. Validation checklist

- `@dronelink/ground-core-node` starts standalone and resolves TLS material through `core-transport`.
- Existing pairing QR/token flow stays unchanged.
- The relay path remains protocol-agnostic.
- `TLS_PROVIDER=tailscale` still flows through `ensureTailscaleTlsMaterial()` at startup.
- Cert/key files remain ignored.
