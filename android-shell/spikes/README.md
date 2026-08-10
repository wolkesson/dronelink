# Phase 2.5 spikes

Phase 2.5 builds `android-shell` — a thin Kotlin/Android wrapper (no business logic) that hosts the unmodified `apps/air-webapp` PWA inside a WebView and gives it native access to things the mobile WebView can't reach on its own: USB serial to the flight controller, camera/mic capture, and a process that survives while flying. See [`../README.md`](../README.md) for the full scope statement and "what not to add" list.

This directory breaks that scope into five spikes, each with its own task brief and its own PR, sequenced from "no hardware needed" to "real flight controller needed":

| # | Spike | Device requirement |
| --- | --- | --- |
| 1 | [WebView shell + localhost PWA host](./spike-1-webview-shell.md) | Emulator is fine |
| 2 | [Camera/mic permission passthrough](./spike-2-camera-mic-passthrough.md) | Emulator for plumbing; real device to confirm |
| 3 | [Foreground service, wake lock, autostart](./spike-3-foreground-service-autostart.md) | Real device strongly preferred |
| 4 | [USB host permission + serial bridge](./spike-4-usb-serial-bridge.md) | Real device required — no emulator path exists |
| 5 | [End-to-end integration](./spike-5-integration.md) | Real device required |

## Emulator vs. real device

A simulated (emulator) Android device is useful for exactly one spike here (Spike 1) and is actively insufficient for the two spikes that make Phase 2.5 hard:

- **USB host mode / serial to the flight controller (Spike 4) cannot be done on an emulator at all.** The Android emulator does not pass through USB host mode to real hardware. This is the core reason Phase 2.5 exists, so real hardware is non-negotiable for it.
- **Foreground service survival, wake locks, and autostart behavior (Spike 3)** are dominated by OEM battery-management quirks (aggressive task killers on Xiaomi/Samsung/etc.) that emulators don't reproduce faithfully.
- **Camera/mic passthrough (Spike 2)** works acceptably on an emulator for wiring/plumbing checks (virtual camera feeds `getUserMedia` fine), but real camera behavior, permission dialogs, and video quality still need a real device before calling it done.

Don't invest setup time in an emulator. Use a real phone as the primary rig starting at Spike 1 — it's sufficient for everything, provided it has working USB-OTG host mode (required for Spike 4; verify this on the device before starting that spike, since many older/budget phones don't support it). If a second device becomes available later, rerunning Spikes 3–5 on it is a good sanity check (different Android version/chipset/OEM skin) before considering Phase 2.5 done, but it isn't a blocker to start.

## Sequencing and dependencies

Spikes 1–3 are independent of each other and of Spike 4, and can be built and merged in any order. Spike 4 is the one that actually implements `NativeBridgeTransport`'s native side and is the highest-risk/highest-value spike. Spike 5 is validation-only (no new code expected) and depends on 1–4 all being merged.

## Reference implementation contract

`packages/air-client-sdk/src/transport/NativeBridgeTransport.ts` and its `.test.ts` define the exact interface the Kotlin bridge must satisfy from the WebView side (currently a stub that throws "not implemented yet" by design). `packages/air-client-sdk/src/transport/WebSerialTransport.ts` is the desktop equivalent, useful for parity-checking `open()`/`write()`/error semantics.

Update the phase-tracking sections in `AGENTS.md`, `README.md`, and `ARCHITECTURE.md` as each spike lands, following the existing "Phase 2 spikes 1–2 are complete" convention.
