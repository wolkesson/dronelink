# android-shell

**Status: intentionally not started yet.**

This component begins in **Phase 2.5** of the development plan (see [`ARCHITECTURE.md`](../ARCHITECTURE.md#6-current-implementation-state)).

## Planned scope

A thin Kotlin/Android wrapper — no business logic lives here. The full air-side logic is in [`apps/air-webapp`](../apps/air-webapp).

Responsibilities:
- **Foreground service** — keeps the process alive during flight so the OS cannot kill it.
- **USB host permission + serial bridge** — requests the Android USB host permission, owns the serial connection to the flight controller, and exposes it to the WebView as a `SerialTransport` over a `WebMessageChannel`. The PWA's `NativeBridgeTransport` is the receiving end.
- **Camera/mic permission passthrough** — requests `CAMERA` and `RECORD_AUDIO` runtime permissions, then grants them through `WebChromeClient.onPermissionRequest` so the PWA's `getUserMedia` call succeeds without native capture code.
- **Wake lock** — prevents CPU/screen sleep mid-flight.
- **Autostart** — launches the foreground service on `BOOT_COMPLETED` and `ACTION_USB_DEVICE_ATTACHED`.
- **Localhost PWA host** — serves the bundled `apps/air-webapp` build over `http://localhost:<port>` (via a small embedded HTTP server) inside a WebView. `file://` is intentionally avoided because `getUserMedia`/WebRTC require a secure context.

## What not to add

- No camera or microphone capture code (the browser engine inside WebView does this via standard web APIs).
- No telemetry parsing, flight-control logic, or UI beyond the WebView container.
- No Kotlin project files until Phase 2.5.
