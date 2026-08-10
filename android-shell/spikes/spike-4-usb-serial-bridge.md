# Spike 4: USB host permission + serial bridge (`NativeBridgeTransport`)

## Goal

Request Android USB host permission, own the serial connection to the flight controller natively, and expose it to the WebView as a serial transport over a `WebMessageChannel` — implementing the receiving contract already stubbed out in `packages/air-client-sdk/src/transport/NativeBridgeTransport.ts`. This is the core reason `android-shell` exists: Android Chrome/WebView doesn't expose `navigator.serial`, so this native bridge is what lets the unmodified PWA talk to the flight controller on Android the way `WebSerialTransport` lets it on desktop.

## Scope

- Request Android USB host permission for the connected FC's USB-serial device.
- Own the serial connection natively (`UsbManager` + a USB-serial driver library, e.g. usb-serial-for-android or equivalent) — read/write loop against the FC.
- Bridge that connection to the WebView via a `WebMessageChannel`, matching the `open()`/`write()` interface `NativeBridgeTransport.ts` expects on the JS side.
- No protocol parsing — the byte stream stays opaque end-to-end, same rule as the rest of the transport layer (see `AGENTS.md` "Key design constraints").

## Non-goals

- Foreground service/wake lock/autostart — Spike 3 (though in practice this spike's USB connection should be established from within that lifecycle once both are merged).
- Camera/mic — Spike 2.
- Any MSP/MAVLink-level parsing.

## Device requirements

**Real device only — there is no emulator path for this spike.** The Android emulator does not support USB host mode passthrough to real hardware, so none of this can be validated without physical hardware. Before starting, confirm the target phone actually has working USB-OTG host mode (check Settings, or test with any USB-OTG accessory) — many older/budget phones don't support it, which would block this spike entirely on that device.

Start with a bench USB-serial adapter for initial read/write-loop wiring before connecting to a real flight controller, to de-risk early bugs without risking FC hardware.

## Depends on

Spike 1 (WebView shell). Independent of Spikes 2 and 3, though final integration happens in Spike 5.

## Files to reference

- `packages/air-client-sdk/src/transport/NativeBridgeTransport.ts` and its `.test.ts` — the exact contract this spike must satisfy from the WebView side. The tests are currently intentionally failing ("not implemented yet") and should be revisited once this bridge exists, so they assert real behavior instead of the placeholder throws.
- `packages/air-client-sdk/src/transport/WebSerialTransport.ts` — the desktop reference implementation; useful for parity-checking `open()`/`write()`/error semantics.
- [`../README.md`](../README.md) — "USB host permission + serial bridge" responsibility.
- `AGENTS.md` — "No protocol parsing in shared transport layers" constraint.

## Exit criteria

- [ ] USB host permission dialog appears and, once granted, the app can open the FC's USB-serial device.
- [ ] Bytes written from the PWA (via `NativeBridgeTransport`) reach the FC over USB.
- [ ] Bytes received from the FC reach the PWA via the same path.
- [ ] Behavior matches `WebSerialTransport`'s semantics closely enough that higher layers (e.g. INAV Configurator via the ground-side TCP bridge) don't need to know which transport is in use.
- [ ] `npm test --workspace @dronelink/air-client-sdk` reflects real passing behavior for `NativeBridgeTransport`, not the placeholder failing tests.
- [ ] Verified against a real flight controller over USB, not just a bench USB-serial adapter.
