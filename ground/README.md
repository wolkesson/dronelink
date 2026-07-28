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

For local testing, set `SIGNAL_SKIP_PAIRING_AUTH=1` to leave `certFingerprint` empty in the pairing bundle and skip the token check on the first WebSocket message.

Run:

```sh
npm install
npm start
```

Pairing authorization is still enforced by the session/token exchange after the `wss` connection is established unless `SIGNAL_SKIP_PAIRING_AUTH=1` is set for local testing.
