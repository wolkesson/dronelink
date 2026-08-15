import qrcodeTerminal from "qrcode-terminal";
import { readFileSync } from "node:fs";
import { TOKEN_PATTERN } from "@dronelink/core-transport";
import { createSignalingServer, setDataChannelCallbacks, startBridge, stopBridge } from "@dronelink/ground-client-sdk";

const PORT = Number(process.env.SIGNAL_PORT ?? 8443);
const HOST = process.env.SIGNAL_HOST ?? "localhost";
// Defaults to HOST rather than a fixed value, since the two must match for TLS
// hostname validation to succeed (the cert is issued for TLS_TARGET; the client
// connects to HOST) — override independently only if you have a real reason to
// (e.g. an mkcert cert covering multiple names while binding a different address).
const TLS_TARGET = process.env.SIGNAL_TLS_TARGET ?? HOST;
const TLS_PROVIDER = process.env.TLS_PROVIDER === "tailscale" ? "tailscale" : "mkcert";

// Fixing these lets the printed QR code be reused across restarts (e.g. printed on
// paper). This trades away the token's normal role as a per-run rotating credential —
// only set these on a trusted network. Unset, behavior is unchanged (random per start).
const PAIRING_SESSION_ID = process.env.PAIRING_SESSION_ID;
if (PAIRING_SESSION_ID !== undefined && PAIRING_SESSION_ID.length === 0) {
  console.error("PAIRING_SESSION_ID is set but empty.");
  process.exit(1);
}

const PAIRING_TOKEN = process.env.PAIRING_TOKEN;
if (PAIRING_TOKEN !== undefined && !TOKEN_PATTERN.test(PAIRING_TOKEN)) {
  console.error("PAIRING_TOKEN is set but invalid: must be 22 base64url characters (A-Z, a-z, 0-9, -, _).");
  process.exit(1);
}

const guiAssets = {
  page: readFileSync(new URL("../../ground-web-client/public/index.html", import.meta.url), "utf8"),
  clientScript: readFileSync(new URL("../../ground-web-client/public/gui-client.js", import.meta.url), "utf8"),
};

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
  tlsProvider: TLS_PROVIDER,
  guiAssets,
  sessionId: PAIRING_SESSION_ID,
  token: PAIRING_TOKEN,
});

void signalingServer
  .start()
  .then((bundle) => {
    console.log(`Signaling server listening on wss://${bundle.host}:${bundle.port}`);
    console.log(`Ground video GUI: https://${bundle.host}:${bundle.port}/gui`);
    console.log("Pairing bundle JSON:");
    console.log(JSON.stringify(bundle, null, 2));
    qrcodeTerminal.setErrorLevel("M");
    qrcodeTerminal.generate(JSON.stringify(bundle), { small: true }, (qr) => console.log(qr));
  })
  .catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`Failed to start signaling server: ${message}`);
    process.exitCode = 1;
  });
