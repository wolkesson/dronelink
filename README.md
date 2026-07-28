# DroneLink

A drone command-and-control (C2) and video link system.

See [`ARCHITECTURE.md`](./ARCHITECTURE.md) for the full system design, component list, tech stack, and phased development plan.

---

## Current phase: Phase 0 — Spikes

Phase 0 is entirely testable with `/ground` plus `/webapp` running in **desktop Chrome** against a real flight controller over Web Serial. **No Android phone or native code is needed.**

Phase 0 spikes:
1. **Pairing spike** — generate a QR/token bundle, scan/parse it, and complete a token-authenticated `wss://` handshake.
2. **Serial spike** — open the real FC's COM port via `navigator.serial` in desktop Chrome, read raw bytes.
3. **Bridge spike** — pipe a recorded byte stream into a local TCP socket, confirm INAV Configurator connects and parses it.

---

## Repo layout

```
/ground              # Node.js/TS — signaling server, WebRTC peer, byte-stream/TCP bridge, video sink
/webapp              # TypeScript PWA — all air-side logic: pairing, WebRTC session, serial byte relay, UI
/android-shell       # Kotlin native shell — NOT started until Phase 2.5 (see below)
/protocol            # Wire-format docs, JSON schemas, recorded byte-stream fixtures
/bridge-firmware     # Future work for iPhone support (ESP32 firmware) — not started
.github/workflows/   # CI (ground-ci.yml, webapp-ci.yml)
```

---

## What NOT to build yet

The following are explicitly out of scope until later phases. Do not start them:

| Component / Feature | Deferred to |
|---|---|
| `/android-shell` (Kotlin foreground service, USB bridge, WebView host) | Phase 2.5 |
| `/bridge-firmware` (ESP32 WiFi/BLE UART bridge for iPhone) | Future work |
| Video capture and forwarding | Phase 2 |
| Reconnection / backoff / resilience logic | Phase 3 |
| Docker Compose / containerized deployment | Phase 4 |
| iPhone air-side app | Future work (after bridge firmware) |

---

## Getting started (Phase 0)

**Prerequisites:** Node.js 22+, npm, desktop Chrome, `mkcert`.

One-time TLS setup (per machine):

```sh
mkcert -install
```

```sh
# Ground software
cd ground
npm install
npm run build
npm test
npm start          # starts the signaling server

# Web app (air-side PWA, run in desktop Chrome)
cd webapp
npm install
npm run dev        # Vite dev server at https://localhost:5173
npm test
```

---

## Running over Tailscale (instead of LAN)

By default `/ground` issues its own local, `mkcert`-trusted certificate for LAN/airgapped bench testing. When the two PCs are on the same tailnet instead, `/ground` can obtain a real, publicly-trusted certificate from Tailscale itself — no `mkcert -install` needed on either machine, and no browser click-through warning to accept.

**One-time tailnet setup (admin console):**
1. Enable **MagicDNS** (DNS page).
2. Under **HTTPS Certificates**, select **Enable HTTPS**, and acknowledge that device names and the tailnet name will be published in the public Certificate Transparency log. This is a real trade-off worth being deliberate about given this project otherwise emphasizes airgapped/private operation — only devices you actually run `tailscale cert` on are published, and it only publishes the *name*, not access or content.

**One-time per machine:**
- Confirm the `tailscale` CLI is callable from a terminal: `tailscale version`. If not found, use the Tailscale install directory directly or add it to PATH.
- Confirm this machine is logged into the tailnet: `tailscale status`.
- Find this machine's MagicDNS name from `tailscale status` or the admin console's Machines page (looks like `pc-a.tailxxxx.ts.net`).

**Running `/ground` in Tailscale mode**, on the PC that will act as ground station:

```sh
# Windows (PowerShell) — replace with this machine's actual MagicDNS name
$env:SIGNAL_HOST = "pc-a.tailxxxx.ts.net"
$env:SIGNAL_TLS_TARGET = "pc-a.tailxxxx.ts.net"
$env:TLS_PROVIDER = "tailscale"
npm start
```

`SIGNAL_HOST` and `SIGNAL_TLS_TARGET` must be set to the **same** MagicDNS name — the certificate is issued for that hostname, and TLS hostname validation will fail if the webapp connects via a raw Tailscale IP instead. `/ground` re-runs `tailscale cert` on every startup; this is safe and inexpensive, since it only actually re-issues from Let's Encrypt when the existing certificate is missing or close to its ~90-day expiry.

On the other PC, run `/webapp` exactly as in the LAN case (`npm run dev`, still served locally over `https://localhost:5173` via `vite-plugin-mkcert` — that part is unaffected by which mode `/ground` is in) and use the pairing bundle `/ground` prints. Its `host` field will now be the MagicDNS name, reachable over the tailnet from anywhere both machines have internet access — no LAN adjacency required.

---

## Contributing

This project is agent-driven (GitHub Copilot, Claude Code) with VS Code as the IDE. See `ARCHITECTURE.md` for design decisions and constraints before making changes.
