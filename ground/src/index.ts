/**
 * Ground software entry point.
 * Starts the embedded WebSocket signaling server and prepares the WebRTC peer.
 *
 * TODO: implement pairing bundle generation (session ID, token, self-signed cert fingerprint),
 *       QR code display, and WebRTC peer setup (Phase 0 spike).
 */
import { createSignalingServer } from "./signaling.js";

const PORT = Number(process.env.SIGNAL_PORT ?? 8443);

const server = createSignalingServer(PORT);
server.on("listening", () => {
  console.log(`Signaling server listening on port ${PORT}`);
});
