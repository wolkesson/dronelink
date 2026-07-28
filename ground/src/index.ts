import { createSignalingServer } from "./signaling.js";
import { setDataChannelCallbacks } from "./webrtc.js";
import { startBridge, stopBridge } from "./tcp-bridge.js";

const PORT = Number(process.env.SIGNAL_PORT ?? 8443);
const HOST = process.env.SIGNAL_HOST ?? "localhost";
const TLS_TARGET = process.env.SIGNAL_TLS_TARGET ?? "localhost";
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
  })
  .catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`Failed to start signaling server: ${message}`);
    process.exitCode = 1;
  });
