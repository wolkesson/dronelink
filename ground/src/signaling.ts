/**
 * Embedded WebSocket signaling server.
 *
 * Runs inside the ground software process — no separate service to deploy.
 *
 * TODO (Phase 0 spike):
 *   - Generate a session bundle (session ID, random token, self-signed TLS cert + fingerprint).
 *   - Serve over `wss://` so the PWA can pin the cert fingerprint scanned from the QR code.
 *   - Implement the token-gated handshake: reject any SDP/ICE exchange until the air-side
 *     presents a matching token.
 *   - Emit QR code (droneops://pair?host=...&port=...&session=...&token=...&fp=...) to stdout.
 */
import { WebSocketServer } from "ws";
import type { Server } from "node:http";

export function createSignalingServer(port: number): WebSocketServer {
  const wss = new WebSocketServer({ port });

  wss.on("connection", (socket) => {
    console.log("Signaling client connected");

    socket.on("message", (data) => {
      // TODO: validate session token, then relay SDP/ICE messages between peers.
      console.log("Received signaling message:", data.toString());
    });

    socket.on("close", () => {
      console.log("Signaling client disconnected");
    });
  });

  return wss;
}
