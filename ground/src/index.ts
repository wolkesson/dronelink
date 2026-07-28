import { createSignalingServer } from "./signaling.js";
import { setDataChannelCallbacks } from "./webrtc.js";
import { startBridge, stopBridge } from "./tcp-bridge.js";

const PORT = Number(process.env.SIGNAL_PORT ?? 8443);
const HOST = process.env.SIGNAL_HOST ?? "localhost";
const TLS_TARGET = process.env.SIGNAL_TLS_TARGET ?? "localhost";
const SKIP_PAIRING_AUTH = isTruthyEnv(process.env.SIGNAL_SKIP_PAIRING_AUTH);

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
  skipPairingAuth: SKIP_PAIRING_AUTH,
});

void signalingServer
  .start()
  .then((bundle) => {
    console.log(`Signaling server listening on wss://${bundle.host}:${bundle.port}`);
    if (bundle.certFingerprint.length > 0) {
      console.log(`TLS certificate fingerprint (SHA-256): ${bundle.certFingerprint}`);
    } else {
      console.log("Pairing auth disabled: certFingerprint omitted.");
    }
    console.log("Pairing bundle JSON:");
    console.log(JSON.stringify(bundle, null, 2));
  })
  .catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`Failed to start signaling server: ${message}`);
    process.exitCode = 1;
  });

function isTruthyEnv(value: string | undefined): boolean {
  if (!value) {
    return false;
  }

  const normalized = value.trim().toLowerCase();
  return normalized === "1" || normalized === "true" || normalized === "yes" || normalized === "on";
}
