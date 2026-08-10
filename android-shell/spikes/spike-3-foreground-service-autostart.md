# Spike 3: Foreground service, wake lock, autostart

## Goal

Keep the app process alive during flight and have it start unattended, so a phone mounted on a drone doesn't need a human to unlock it and reopen the app after a reboot or USB reconnect.

## Scope

- A foreground service (with the required notification) that keeps the process alive while the app is running, so the OS is much less likely to kill it under memory pressure.
- A `PowerManager` wake lock to prevent CPU/screen sleep mid-flight.
- Broadcast receivers for `BOOT_COMPLETED` and `ACTION_USB_DEVICE_ATTACHED` that launch the foreground service automatically.

## Non-goals

- USB/serial bridging logic itself — Spike 4 (this spike only needs to *react* to the USB-attached broadcast, not talk to the device).
- Camera/mic passthrough — Spike 2.
- Any telemetry/flight-control logic — stays in `apps/air-webapp` / `packages/air-client-sdk`.

## Device requirements

A real device is strongly preferred for this spike. The APIs themselves (foreground service, wake lock, boot receiver) can technically be exercised on an emulator, but the behavior that actually matters here — whether the OS actually keeps the process alive under real memory/battery pressure — is dominated by OEM-specific battery-management quirks (aggressive task killers on Xiaomi/Samsung/etc. via manufacturer battery optimization) that emulators don't reproduce. If a second real device becomes available later, rerunning this spike on it is a good way to catch OEM-specific regressions before trusting it for real flights.

## Depends on

Spike 1 (WebView shell) should be in place first. Independent of Spikes 2 and 4.

## Files to reference

- [`../README.md`](../README.md) — "Foreground service", "Wake lock", and "Autostart" responsibilities.

## Exit criteria

- [ ] Foreground service starts when the app launches and shows the required persistent notification.
- [ ] Wake lock prevents screen/CPU sleep while the service is running.
- [ ] Service survives an extended idle period (screen off, app backgrounded) without being killed.
- [ ] After a device reboot with the USB accessory already attached, the service starts automatically with no user interaction (`BOOT_COMPLETED`).
- [ ] Attaching the USB accessory while the phone is already unlocked/running also triggers service start (`ACTION_USB_DEVICE_ATTACHED`), for the case where the phone reboots independently of the accessory.
- [ ] Tested on a real device, not just an emulator.
