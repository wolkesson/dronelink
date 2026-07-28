# DroneLink Webapp

Air-side PWA (pairing, WebRTC session, serial byte relay, UI).

## Local development TLS

One-time setup (per machine):

```sh
mkcert -install
```

Then run the app:

```sh
npm install
npm run dev
```

The Vite dev server uses `vite-plugin-mkcert` and serves over `https://`.
