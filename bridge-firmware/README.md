# bridge-firmware

**Status: future work — not started.**

See [`ARCHITECTURE.md`](../ARCHITECTURE.md#7-open-items--future-work) for context.

## Planned scope

ESP32 (or similar) firmware that bridges a flight controller's UART to WiFi or BLE. Intended for the iPhone air-side path, since iOS has no route to generic USB serial host access without MFi certification.

The specific wireless technology (WiFi vs BLE) is undecided — no work has started and no hardware has been selected.

## Why this is deferred

- iPhone air-side is explicitly out of scope until the Android path is proven end-to-end.
- Android keeps direct USB serial for the foreseeable future (no bridge needed there).
- The byte-stream bridging in `/ground` and `/webapp` is already protocol-agnostic; adding a WiFi/BLE transport later is a new `SerialTransport` implementation plus this firmware, with no changes to the core relay logic.
