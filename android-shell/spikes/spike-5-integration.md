# Spike 5: End-to-end integration

## Goal

Validate that Spikes 1–4 compose correctly under real conditions: foreground service + wake lock + USB serial to a real FC + camera capture + WebRTC to the ground client, running for a realistic session length, including autostart after a reboot with USB already attached.

## Scope

This spike is validation-only — no new `android-shell` features are expected. If gaps are found while integrating, fix them in the relevant spike's code rather than adding new scope here.

- Run the full stack together on a real device: boot → autostart (Spike 3) → USB serial to FC (Spike 4) → camera capture (Spike 2) → WebRTC to the ground client, inside the WebView shell (Spike 1).
- Exercise the ground-side workflow from `README.md` ("Getting started") against the Android device instead of desktop Chrome: pairing, `Connect FC`, INAV Configurator over the TCP bridge, and the ground video GUI.
- Observe behavior over an extended session: battery drain, thermal throttling, and Wi-Fi/Tailscale connectivity from a handheld device instead of a desktop.

## Non-goals

- New native features — this spike should not need them if 1–4 were scoped correctly.

## Device requirements

Real device, required — this spike depends on Spike 4's real-hardware-only USB bridge. If a second phone is available by this point, run the full session on both: once to close out Phase 2.5 on the primary device, and again on the second device to catch device-specific regressions (different Android version/chipset/OEM skin) before trusting the shell for actual flights.

## Depends on

Spikes 1, 2, 3, and 4 must all be merged before this spike can be meaningfully run.

## Files to reference

- `README.md` — "Getting started" section, which this spike replays against the Android shell instead of desktop Chrome.
- `ARCHITECTURE.md` §7 "Validation checklist" — existing Phase 1/2 validation items this spike should continue to hold true on Android.

## Exit criteria

- [ ] A full session — power-on, autostart, USB connect to FC, camera capture, WebRTC to ground — runs with no manual intervention beyond normal app-launch UX.
- [ ] The ground-side pairing → `Connect FC` → INAV Configurator (via TCP bridge) → video GUI workflow works end-to-end against the Android device.
- [ ] The session survives long enough to be representative of a real flight (define a target duration before starting, e.g. 20–30 minutes) without the process being killed or the USB/video link dropping.
- [ ] Reboot-with-USB-attached autostart verified as part of this full-stack run, not just in isolation (Spike 3's own exit criteria).
- [ ] `AGENTS.md`, `README.md`, and `ARCHITECTURE.md` updated to mark Phase 2.5 complete once this spike passes.
