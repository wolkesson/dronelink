import qrcodeTerminal from "qrcode-terminal";
import { createSignalingServer } from "./signaling.js";
import { setDataChannelCallbacks } from "./webrtc.js";
import { startBridge, stopBridge } from "./tcp-bridge.js";

const PORT = Number(process.env.SIGNAL_PORT ?? 8443);
const HOST = process.env.SIGNAL_HOST ?? "localhost";
// Defaults to HOST rather than a fixed value, since the two must match for TLS
// hostname validation to succeed (the cert is issued for TLS_TARGET; the client
// connects to HOST) — override independently only if you have a real reason to
// (e.g. an mkcert cert covering multiple names while binding a different address).
const TLS_TARGET = process.env.SIGNAL_TLS_TARGET ?? HOST;
const TLS_PROVIDER = process.env.TLS_PROVIDER === "tailscale" ? "tailscale" : "mkcert";

setDataChannelCallbacks(
  (channel) => {
    startBridge(channel);
  },
  () => {
    stopBridge();
  },
);

const signalingServer = createSignalingServer({
  port: PORT,
  host: HOST,
  tlsTarget: TLS_TARGET,
  tlsProvider: TLS_PROVIDER
});

void signalingServer
  .start()
  .then((bundle) => {
    console.log(`Signaling server listening on wss://${bundle.host}:${bundle.port}`);
    console.log(`TLS certificate fingerprint (SHA-256): ${bundle.certFingerprint}`);
    console.log("Pairing bundle JSON:");
    console.log(JSON.stringify(bundle, null, 2));
    qrcodeTerminal.generate(JSON.stringify(bundle), { small: true }, (qr) => console.log(qr));
  })
  .catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`Failed to start signaling server: ${message}`);
    process.exitCode = 1;
  });
