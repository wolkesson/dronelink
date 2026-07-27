# DroneLink

A drone command-and-control (C2) and video link system.

See [`ARCHITECTURE.md`](./ARCHITECTURE.md) for the full system design, component list, tech stack, and phased development plan.

---

## Current phase: Phase 0 — Spikes

Phase 0 is entirely testable with `/ground` plus `/webapp` running in **desktop Chrome** against a real flight controller over Web Serial. **No Android phone or native code is needed.**

Phase 0 spikes:
1. **Pairing spike** — generate a QR/token bundle, scan/parse it, complete a `wss://` handshake with cert pinning.
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

**Prerequisites:** Node.js 22+, npm, desktop Chrome.

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
npm run dev        # Vite dev server at http://localhost:5173
npm test
```

---

## Contributing

This project is agent-driven (GitHub Copilot, Claude Code) with VS Code as the IDE. See `ARCHITECTURE.md` for design decisions and constraints before making changes.
