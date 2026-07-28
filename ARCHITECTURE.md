# Drone C2/Video Link — Architecture & Development Plan

Status: draft v2
Scope: Android air-side native shell + TypeScript PWA (air-side logic) + ground control software. WebRTC link between them, protocol-agnostic MSP/MAVLink byte bridging, QR/manual pairing. iPhone air-side is deferred (see Future Work).

## 1. Goals & constraints

- Air side: a phone mounted on the drone reads FC telemetry/control over USB serial and captures its own camera/mic, forwarding both to the ground over a single WebRTC link.
- Ground side: software receives both, exposes the byte stream to INAV Configurator/GCS over TCP, and displays/re-serves video.
- Must run either fully airgapped (LAN only) or over the internet via Tailscale.
- Neither app parses the serial protocol — it's forwarded as an opaque byte stream, so MSP, MAVLink, or anything else the FC emits works without app changes.
- Development is agent-driven (GitHub Copilot, Claude Code), IDE is VS Code. The plan front-loads risk validation to keep agent iteration cheap.
- Current hardware: two Windows PCs, one wired to a real flight controller over USB serial. No Android phone yet (see Phase 2.5). No iPhone, no wireless bridge hardware.

## 2. Components

| Component | Role | Platform/Language |
| --- | --- | --- |
| Ground software | Signaling, WebRTC peer, byte-stream↔TCP bridge (protocol-agnostic), video sink | Node.js + TypeScript, `werift` (pure-TS WebRTC) |
| Air-side PWA (`/webapp`) | All air-side logic: pairing, WebRTC session, serial byte relay, UI. Runs in desktop Chrome for Phase 0–2, and inside the Android WebView from Phase 2.5 on | TypeScript, Vite + `vite-plugin-pwa` |
| Android native shell (`/android-shell`) | Thin wrapper only: foreground service, USB permission + serial I/O, camera/mic permission passthrough, wake lock, autostart, hosts the PWA build over `localhost` in a WebView | Kotlin/Android — not started until Phase 2.5 |
| Protocol/fixtures | Wire-format docs, recorded byte-stream fixtures, signaling message schema | Shared docs + JSON |
| INAV Configurator/GCS | Third-party, unmodified | Connects to ground software over TCP |
| Wireless bridge (future) | UART↔WiFi/BLE bridge for iPhone air-side | ESP32 firmware — not started |

Because Web Serial is unavailable on Android, the PWA's serial access is abstracted behind a `SerialTransport` interface with two implementations: a `WebSerialTransport` (desktop Chrome, `navigator.serial`, used through Phase 0–2) and a `NativeBridgeTransport` (Android WebView, receives bytes handed over from the native shell via a `WebMessageChannel`). Everything above that interface — pairing, WebRTC session management, the relay itself — is identical code in both environments.

## 3. Key design decisions

**Signaling lives inside the ground software.** No separate signaling service to deploy or secure.

**Pairing/authentication: QR code (primary) or manual code (fallback).**
On startup, the ground software generates a session bundle: session ID and a random token. Shown as a QR code (`droneops://pair?host=...&port=...&session=...&token=...`). The air-side PWA scans it (via `getUserMedia` + a JS barcode-decoding library — no native code needed), connects over `wss`, and presents the token before any SDP/ICE exchange is allowed. Manual entry (host + token) is a fallback for when scanning isn't possible. Once paired, the ground software remembers the device.

Certificate trust is handled out-of-band, not by app code, because browser JavaScript has no API to inspect or pin a TLS certificate — the browser's own network stack accepts or rejects the handshake before any page script runs, so a "verify the fingerprint in JS" step (as earlier drafts of this doc described) isn't actually implementable in a plain browser context. During Phase 0–2 desktop testing, trust is established either by manually accepting the browser's self-signed-cert warning once per machine, or — recommended for repeated testing — by using `mkcert` to install a local dev CA once (`mkcert -install`) and issuing the ground software's cert from it, which removes the warning entirely. The token exchange after the WebSocket connects remains the real, enforceable app-level authorization gate in this phase. Genuine certificate pinning becomes possible starting Phase 2.5, inside the Android native shell, since native code has access to `TrustManager`/`WebViewClient.onReceivedSslError` APIs that page JavaScript does not.

**Byte-stream bridging, protocol-agnostic.** Neither side parses the serial data. Read from serial (or the Android USB bridge), forward over the WebRTC data channel (ordered/reliable), write to a local TCP socket on the ground side. Protocol choice (MSP, MAVLink, etc.) is entirely an FC/GCS configuration decision.

**Nearly all air-side logic lives in TypeScript, in a PWA.** The Android native shell is intentionally minimal:
- Keeps a foreground service running, so the process isn't killed by the OS during flight.
- Owns the USB device: requests the USB host permission, reads/writes the serial connection (`usb-serial-for-android` or direct `android.hardware.usb`), and exposes it to the WebView as a `SerialTransport` over a `WebMessageChannel`.
- Requests Android CAMERA/RECORD_AUDIO runtime permissions and grants them through WebView's `onPermissionRequest` callback — actual capture is `getUserMedia` in the PWA, not native camera code.
- Holds a wake lock so the screen/CPU don't sleep mid-flight.
- Auto-launches on `BOOT_COMPLETED` and on `ACTION_USB_DEVICE_ATTACHED`, starting the foreground service and loading the PWA.
- Serves the bundled PWA over `http://localhost:<port>` (via a small embedded HTTP server) rather than `file://`, since `getUserMedia`/WebRTC require a secure context.

This also means camera/mic capture needs no CameraX/AVFoundation-equivalent native code at all — the browser engine (WebView is Chromium-based) does it via standard web APIs, same as it does on desktop.

**Android stays on direct USB serial for now.** iPhone air-side is deferred; when built it will use a wireless UART bridge (WiFi or BLE, undecided), since iOS has no path to generic USB-serial host access without MFi certification.

## 4. Repo layout (monorepo)

```text
/ground              # Node.js/TS ground software (signaling, WebRTC peer, byte-stream/TCP bridge, video sink)
/webapp              # TypeScript PWA — all air-side logic
  /src
    /core             # transport-agnostic: pairing, session state machine, WebRTC relay logic
    /transport          # SerialTransport implementations (WebSerialTransport, NativeBridgeTransport)
    /ui
/android-shell       # Kotlin native shell: foreground service, USB bridge, permissions, wake lock, autostart, localhost host — NOT started until Phase 2.5
/protocol            # Wire-format docs, JSON schemas, recorded byte-stream fixtures used by all test suites
/bridge-firmware     # (future) ESP32 UART↔WiFi/BLE bridge for iPhone air-side — not started
.github/workflows/   # CI
```

## 5. DevOps plan

- **CI (GitHub Actions):**
  - `/ground`: build, lint, unit tests, integration tests against INAV SITL run as a service container.
  - `/webapp`: build (Vite), lint, unit tests for `/core` logic; optionally a headless Node-based harness later (swapping in `werift` + a mock/SITL transport) for automated regression testing without a browser.
  - `/android-shell`: build, lint, instrumented tests against a mocked USB serial device and mocked WebView bridge — added starting Phase 2.5, not before.
  - Protocol contract tests: `/ground` and `/webapp` both run their suites against the same fixtures in `/protocol`.
- **INAV SITL** is the default fake flight controller for automated testing.
- **Local dev TLS:** both `/webapp` (in dev) and `/ground` should be served over HTTPS/`wss` using certs issued by a shared local CA (`mkcert`), not ad-hoc self-signed certs. This isn't just about avoiding browser warnings — `navigator.serial` and `getUserMedia` both require a secure context, and plain `http://` on anything but `localhost` doesn't qualify, which would silently break the serial and QR-scanning spikes. Use `vite-plugin-mkcert` for `/webapp`'s dev server, and issue `/ground`'s cert from the same local CA (`mkcert <lan-ip> localhost 127.0.0.1`).
- **Ground software is containerized**, validated for both airgapped (no egress) and Tailscale-joined networking.
- `/android-shell` and `/bridge-firmware` are placeholders in the repo layout with no CI or tickets targeting them yet.

## 6. Development plan

**Phase 0 — spikes**
1. Pairing spike: generate a QR/token bundle, scan/parse it, complete a `wss` handshake with cert pinning — run entirely as `/ground` plus the `/webapp` in a desktop Chrome tab. No hardware needed.
2. Serial spike: with the real FC wired to PC B, use `navigator.serial` in desktop Chrome to open the port and read raw bytes — confirms the hardware/driver path works, independent of networking or any native code.
3. Bridge spike: pipe a recorded byte stream into a local TCP socket and confirm INAV Configurator on PC A connects and parses it.

**Phase 1 — thin end-to-end pipe (both PCs, real FC, desktop Chrome only)**
Run `/webapp` in desktop Chrome on PC B: read real serial from the FC via `WebSerialTransport` → pair with and connect to `/ground` on PC A over WebRTC → ground software bridges to a local TCP port → INAV Configurator on PC A shows live telemetry. Fully real hardware, zero native/Android code.

**Phase 2 — video track (both PCs, desktop Chrome only)**
Add `getUserMedia` video capture to `/webapp` (PC B's webcam stands in for the phone camera) and confirm `/ground` receives and displays it.

**Phase 2.5 — Android native shell (when a phone is available)**
Build `/android-shell` for the first time: foreground service, USB permission + serial bridge over a `WebMessageChannel`, camera/mic permission passthrough, wake lock, boot/USB-attach autostart, and a `localhost` server hosting the `/webapp` build in a WebView. Implement `NativeBridgeTransport` in `/webapp` to receive bytes from the shell instead of `navigator.serial`. Because the pairing, session, and relay logic were already fully proven in Phases 0–2, this phase is scoped to native platform integration risk only — USB host reliability on the specific phone, WebView's `onPermissionRequest`/getUserMedia behavior, foreground service correctness, thermal/power under load.

**Phase 3 — resilience**
Reconnection/backoff on link drop, fault-injection tests, signaling auth edge cases.

**Phase 4 — deployment modes**
Airgapped LAN validation via Docker Compose with egress disabled; Tailscale validation over an actual tailnet.

**Phase 5 — real flight integration**
Move from bench setup to the Android phone mounted on the drone. Software correctness is already proven by this point; this phase validates the physical/RF/vibration/power side.

## 7. Open items / future work

- Protocol-aware channel prioritization (splitting high-rate telemetry onto a separate unreliable/unordered data channel) is deferred, and would need only frame-boundary detection, not full parsing — applies equally to MSP or MAVLink.
- Wireless bridge transport for iPhone (WiFi vs BLE) — not yet decided, no work started.
- iPhone air-side app — deferred until the bridge exists.
- Whether Android should eventually move to the same bridge model for consistency — explicitly deferred; Android keeps direct USB for now.
- Standardizing on a specific Android phone model, once available, to collapse the USB-host/WebView-permission compatibility matrix to one validated device.
- Whether `/webapp`'s manifest/service worker (the "installable PWA" parts) are worth keeping meaningful in the Android WebView context, versus being primarily useful for the desktop Chrome test harness — the native shell loads the app directly into a WebView rather than through Chrome's install flow, so this is a documentation/expectation question rather than a technical blocker.
