# Spike 1: WebView shell + localhost PWA host

## Goal

Prove the unmodified `apps/air-webapp` production build loads and runs correctly inside a bare Kotlin `WebView`, served over `http://localhost:<port>` by an embedded HTTP server — not `file://`, because `getUserMedia`/WebRTC require a secure context (see [`../README.md`](../README.md)).

## Scope

- New `android-shell` Gradle/Kotlin project skeleton (single `Activity` hosting a `WebView`).
- An embedded HTTP server (e.g. NanoHTTPD or similar lightweight option) serving the bundled `apps/air-webapp` `dist/` output over `http://localhost:<port>`.
- `WebView` configured with JavaScript enabled and whatever settings are needed for a modern PWA (DOM storage, etc.).
- Basic app icon/launcher entry so it installs and opens like a normal app.

## Non-goals (do not implement in this spike)

- USB/serial bridging — that's Spike 4.
- Camera/mic permission passthrough — that's Spike 2.
- Foreground service, wake lock, autostart — that's Spike 3.
- Any telemetry parsing, flight-control logic, or UI beyond the WebView container (see "what not to add" in `../README.md`).

## Device requirements

Emulator is fine for this spike — no hardware access is needed yet. A real phone works too and is a better sanity check for WebView engine quirks (the WebView's Chrome version is tied to the OS/Play Services version, which varies more on real devices than on a fresh emulator image).

## Files to reference

- [`../README.md`](../README.md) — full component scope and constraints.
- `apps/air-webapp/vite.config.ts` — PWA build config; this spike serves that build's `dist/` output.
- `apps/air-webapp/package.json` — build command to produce the bundle to embed/package.

## Exit criteria

- [ ] App launches on an emulator (and ideally a real device) and the WebView renders the `air-webapp` UI.
- [ ] Basic navigation and JS execution work inside the WebView (no console errors from missing secure-context APIs at this stage — those calls just won't be exercised yet).
- [ ] Confirm the app is served from `http://localhost:<port>`, not `file://`.
- [ ] No USB/camera/foreground-service code included (out of scope for this spike).
