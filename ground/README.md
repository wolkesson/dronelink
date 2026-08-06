# DroneLink Ground

Ground control software (signaling server, WebRTC peer, byte-stream/TCP bridge, video sink).

## Local development TLS

One-time setup (per machine):

```sh
mkcert -install
```

On first start, the ground server issues and stores its TLS cert/key via `mkcert` for:
- `localhost`
- `127.0.0.1`
- `SIGNAL_TLS_TARGET` (defaults to `localhost`, set this to your LAN IP/hostname as needed)

Run:

```sh
npm install
npm start
```

Pairing authorization is still enforced by the session/token exchange after the `wss` connection is established.

## Local live video viewer (Phase 2 spike 2)

When the ground process is running, open:

- `https://localhost:8443/viewer` (or your configured `SIGNAL_HOST`/`SIGNAL_PORT`)

Click **Connect viewer** to establish the local loopback WebRTC session and render the incoming air-side video in the browser tab.
