# DroneLink

A drone command-and-control (C2) and video link system.

See [`ARCHITECTURE.md`](./ARCHITECTURE.md) for the full system design, package boundaries, and phased development plan.

---

## Status

The real FC → WebRTC → TCP bridge path works end-to-end over both LAN and Tailscale. The air-side camera picker/live preview, ground-side video recording, and live video GUI are available without changing the protocol-agnostic byte relay. `android-shell` (WebView shell + localhost PWA host, camera/mic permission passthrough, foreground service/wake lock/autostart, USB host serial bridge) has been validated end-to-end on real hardware: unattended reboot autostart, the FC/camera/WebRTC pipeline, ground pairing, INAV Configurator over the TCP bridge, and a 45+ minute soak session. See [`android-shell/README.md`](./android-shell/README.md) for Android-specific setup and device-testing notes.

See [`ARCHITECTURE.md`](./ARCHITECTURE.md#6-current-implementation-state) for the full implementation-state breakdown, including known limitations.

---

## Workspace layout

```text
apps/
  ground-core-node/    # headless signaling host + TCP bridge runtime
  ground-web-client/   # ground-side live video GUI composition
  air-webapp/          # air-side PWA composition shell
packages/
  core-transport/      # pairing/token protocol, TLS helpers, shared transport primitives
  ground-client-sdk/   # ground-side signaling/WebRTC/TCP-bridge runtime logic
  air-client-sdk/      # air-side pairing/session/serial transport logic
  ui-kit-shared/       # cross-side UI-facing presentation helpers
  ui-kit-ground/       # ground-only UI-facing scaffold
protocol/              # schemas, fixtures, wire-format docs
android-shell/         # native Android WebView shell (see android-shell/README.md)
bridge-firmware/       # future work, do not touch yet
```

### Dependency direction

- `packages/core-transport` contains shared, non-app transport primitives.
- `packages/ground-client-sdk` and `packages/air-client-sdk` depend on `packages/core-transport`.
- `packages/ui-kit-shared` and `packages/ui-kit-ground` stay presentation-only and do not reach into SDK internals.
- `apps/*` compose packages; business logic should not live directly in app packages.

The split is by **concern**, not simply by ground vs air. Shared transport/pairing logic lives in reusable packages so the ground and air shells stay thin as more UI surfaces are added.

---

## Getting started (desktop workflow)

**Prerequisites:** Node.js 22+, npm, desktop Chrome, `mkcert`.

One-time TLS setup (per machine):

```sh
mkcert -install
```

Install workspace dependencies once from the repo root:

```sh
npm install
```

Run the ground-side headless process:

```sh
npm start --workspace @dronelink/ground-core-node
```

Run the air-side web app:

```sh
npm run dev --workspace @dronelink/air-webapp
```

1. Open `https://localhost:5173` in desktop Chrome.
2. Paste the pairing bundle printed by `@dronelink/ground-core-node` (or scan its QR code) and click **Pair**.
3. Click **Connect FC** and select the FC's serial port.
4. In INAV Configurator, connect to `localhost:5761` (TCP).
5. Open the `Ground video GUI` URL printed by the ground runtime to view the incoming camera feed while it is recorded.

To run validation locally:

```sh
npm run build --workspace @dronelink/core-transport
npm run build --workspace @dronelink/ground-client-sdk
npm run build --workspace @dronelink/air-client-sdk
npm run build --workspace @dronelink/ui-kit-shared
npm run build --workspace @dronelink/ground-core-node
npm run build --workspace @dronelink/air-webapp

npm test --workspace @dronelink/core-transport
npm test --workspace @dronelink/ground-client-sdk
npm test --workspace @dronelink/air-client-sdk
npm test --workspace @dronelink/ui-kit-shared
```

---

## Running over Tailscale

Set `SIGNAL_HOST`, `SIGNAL_TLS_TARGET`, and `TLS_PROVIDER=tailscale` before starting `@dronelink/ground-core-node`. `ensureTailscaleTlsMaterial()` now lives in `packages/core-transport` and is still invoked by the ground runtime at startup.

Example:

```sh
SIGNAL_HOST=pc-a.tailxxxx.ts.net \
SIGNAL_TLS_TARGET=pc-a.tailxxxx.ts.net \
TLS_PROVIDER=tailscale \
npm start --workspace @dronelink/ground-core-node
```

The air-side app still runs locally via `npm run dev --workspace @dronelink/air-webapp` and uses the pairing bundle printed by the ground process.

---

## Testing on a real Android device over LAN

Tailscale requires Android 8+; older devices need the LAN + mkcert path instead. This needs two extra steps beyond the desktop workflow above, because self-signed dev certificates aren't trusted automatically outside of the machine that ran `mkcert -install`:

1. Start the ground runtime bound to this machine's LAN IP (not `localhost`), so the phone can reach it:

   ```sh
   SIGNAL_HOST=<lan-ip> npm start --workspace @dronelink/ground-core-node
   ```

2. Run `air-webapp` with `--host` so its dev server is reachable from other devices on the LAN:

   ```sh
   npm run dev --workspace @dronelink/air-webapp -- --host
   ```

3. Install the mkcert root CA on the phone so both origins (the `air-webapp` dev server and the ground runtime) are trusted. A browser's per-tab "proceed anyway" click-through does **not** carry over to an installed PWA or to `android-shell`'s WebView — only a full CA install does:

   - On the machine that ran `mkcert -install`, find the root cert: `mkcert -CAROOT` prints the folder; the file is `rootCA.pem` inside it.
   - Transfer `rootCA.pem` to the phone (email it to yourself, a cloud drive, or `adb push rootCA.pem /sdcard/Download/`).
   - On the phone: **Settings → Security → Encryption & credentials → Install a certificate → CA certificate**, then select `rootCA.pem`. Android requires a screen lock (PIN/pattern) to be set before it allows installing a user CA. A "Network may be monitored" banner afterward is expected — Android flagging that a non-OS-trusted root is active, not an error.
   - Confirm it installed under **Settings → Security → Trusted credentials → User**.

Once installed, the same CA is trusted by Chrome tabs, installed PWAs, and `android-shell`'s WebView alike, so no further per-visit click-through is needed.

---

## What not to build yet

- `bridge-firmware` (ESP32 WiFi/BLE UART bridge for iPhone)
- Ground-side GUI features beyond the live video viewer
- Reconnection / backoff / resilience logic
- Docker Compose / containerized deployment
- iPhone air-side app
