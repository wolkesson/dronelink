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
- Ground-initiated video quality control (Auto/High/Low/Data-only) via the `video-control-request`/`video-control-state` signaling messages
- Ground-initiated camera source switching: air publishes its enumerated camera list (`control: "camera-source-list"`) once connected and after every switch; the ground GUI offers those devices, and a selection is relayed as a `control: "camera-source"` request, applied via the same `WebRtcSessionManager.replaceVideoTrack`/`addVideoTrack` path the local device picker uses
- Air-unit battery status: air watches the Battery Status API (`startBatteryMonitor`) and sends an unsolicited `air-status` message (`protocol/schemas/air-status.schema.json`) on connect and on every level/charging change; ground relays it to the GUI, caches the latest to replay to a viewer that attaches later, and blanks it when air disconnects. The GUI shows it as a percentage, warning at 20% (low) and 10% (critical) when not charging
- Air-unit mobile data usage: the same `air-status` message carries `dataUsage` (cumulative WebRTC payload tx/rx bytes, sampled from `getStats()` once a second and accumulated across peer-connection restarts). Measured on air because the phone is what's on the metered link; the GUI derives the current rate from successive samples and shows the session total. It excludes IP/DTLS overhead and signaling, so the carrier's figure will be somewhat higher
- Ground-initiated video flip/rotation (horizontal/vertical mirroring, 90-degree-step rotation), for when the phone can't be mounted in the correct orientation: the ground GUI's flip checkboxes and rotate-left/rotate-right buttons send `control: "flip"`/`control: "rotate"` requests; air redraws the camera feed onto a canvas with the combined mirror/rotate 2D transform and swaps the canvas's `captureStream()` track into the sender via `replaceVideoTrack`, since raw camera tracks and `RTCRtpSender` have neither capability. The canvas always keeps the source's own width/height (rotated content is letterboxed to fit rather than swapping dimensions), so no resolution desync — see the known limitation below
- Ground GUI video zoom-to-fill/fit: a "Zoom to fill" checkbox next to the flip controls toggles the local `<video>` element's `object-fit` between `contain` (fit, default — the whole frame visible, letterboxed if its aspect doesn't match the display box) and `cover` (fill — crops to fill the box, no letterboxing). Purely a per-viewer playback preference on whatever stream is already arriving; unlike flip/rotate there's nothing for air to apply and no signaling message involved
- Air-side camera settings persistence (`CameraSettingsStore`, `localStorage`-backed): per-camera flip/rotation is saved on every applied `flip`/`rotate` control and restored on every `switchCameraTo()` for that camera, instead of carrying the previously active camera's transform over to a different one. A default camera, set from the ground GUI's "Set as default" button (`control: "camera-set-default"`), is opened automatically the next time the air webapp loads and enumerates devices — before any ground station has paired, and confirmed surviving a real force-stop/relaunch — and is included in the `camera-source-list` push (`defaultDeviceId`) so the ground GUI can show which one it is. Since each camera can have its own saved transform, `camera-source-list` also carries the newly-active camera's actual flip/rotation (`activeTransform`) on every push, so the ground GUI's flip checkboxes/rotation label follow a switch instead of showing the previous camera's stale value (and the rotate buttons computing off it). Keyed by the camera's own **label**, not `MediaDeviceInfo.deviceId` — confirmed against a real Android WebView, `deviceId`/`groupId` are salted fresh on every page load there, so only `label` stays stable across the reload/restart/reboot this store needs to survive (`android-shell`'s local server also had to move off an OS-assigned port to a fixed one for the same reason — see `android-shell/README.md`). All of this lives on the air unit, not synced ground-to-ground, since it describes how *this* phone is physically mounted, not a per-pairing preference
- `android-shell`: WebView shell + localhost PWA host, camera/mic permission passthrough, foreground service/wake lock/autostart, and the USB host serial bridge (`NativeBridgeTransport`) — validated end-to-end on real hardware (unattended reboot autostart, the FC/camera/WebRTC pipeline, ground pairing, INAV Configurator over the TCP bridge, and a 45+ minute soak session)

The video control messages (`protocol/schemas/video-control-request.schema.json`, `video-control-state.schema.json`) are deliberately shaped as a `control`-discriminated envelope, with `"quality"`, `"camera-source"`, `"camera-set-default"`, `"flip"`, and `"rotate"` implemented today (plus `"camera-source-list"`, air's unsolicited device-list push, on the state side only). Further ground-initiated video controls — zoom, gain/contrast — are expected to be added as new `control` cases in `air-client-sdk`'s `WebRtcSessionManager` and new GUI widgets, without renaming the protocol or changing `ground-client-sdk`'s relay code, which stays agnostic to the payload shape: adding camera-source, camera-set-default, flip, and rotate each required zero changes to `ground-client-sdk`, confirming the design.

Camera capture (`getUserMedia`, device enumeration) is owned by `air-webapp`'s app layer, not `air-client-sdk` — the SDK stays transport-only and exposes `setCameraSourceHandler()` for the app to register its own switch logic (`switchCameraTo()` in `app.ts`), the same separation the local device-picker dropdown already relied on. Flip and rotate follow the same split: `setFlipHandler()`/`setRotateHandler()` let the app own the actual frame transform (`video-transform.ts`'s combined mirror/rotate canvas re-render pipeline) while the SDK only dispatches each request and reports the handler's ok/error outcome. `setCameraDefaultHandler()` follows the same pattern for `camera-set-default` — the SDK only dispatches; `app.ts` validates the deviceId and writes it via `CameraSettingsStore`, which (unlike the transport-only SDK) is deliberately a browser-storage wrapper living in `air-client-sdk` anyway, the same call as `BatteryMonitor`: both wrap a raw browser API (`localStorage`, `navigator.getBattery`) behind a small interface the app composes, rather than being session/protocol logic themselves.

### Known limitation

`android-shell`'s USB connection now lives in `AirShellForegroundService` (via `UsbSerialSession`), not `MainActivity` — backgrounding/recreating the Activity no longer tears down the USB link, since `NativeSerialBridgeController` just attaches/detaches a listener to the already-running session instead of owning the `UsbSerialBridge` itself. This has been through unit tests and a full Gradle build but not yet a real-device pass (Activity recreation with USB alive, cold-start-still-requires-a-tap, hot replug, no-WebView-attached — see `android-shell/README.md`'s USB testing steps); treat it as implemented but not yet hardware-validated.

Mid-session video source switching (`WebRtcSessionManager.replaceVideoTrack`, air-webapp's device picker while connected) swaps the outbound `MediaStreamTrack` in place via `RTCRtpSender.replaceTrack` and skips renegotiation entirely. The ground side has no way to learn about the swap: its `MediaRecorder` is sized once from the `videoWidth`/`videoHeight` signaled in the original SDP offer (`ground-client-sdk`'s `webrtc.ts`) and never re-reads dimensions afterward. Switching to a source with a different resolution mid-session will desync the recorder from the actual frame size and can corrupt the recording — only same-resolution swaps are safe today. The ground-initiated "Low" video quality preset (see below) has the same failure mode: it changes the encoded frame size via `scaleResolutionDownBy` with no renegotiation, so it desyncs the *recorded file's* container metadata the same way (the live GUI viewer is unaffected — it's a raw RTP relay with no static dimension metadata). Fixing this needs a new signaling message so the ground side can resize or restart the recorder when the source changes.

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
