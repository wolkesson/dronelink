import { randomUUID } from "node:crypto";
import { createServer, type Server as HttpsServer } from "node:https";
import { homedir } from "node:os";
import { join } from "node:path";
import { WebSocketServer } from "ws";
import {
  createPairingAcceptedMessage,
  createPairingBundle,
  ensureTailscaleTlsMaterial,
  ensureTlsMaterial,
  generateSessionId,
  generateToken,
  isPairingRequest,
  type PairingBundle,
} from "./pairing.js";
import {
  handleSignalingMessage,
  handleSocketClose,
  handleViewerSignalingMessage,
  handleViewerSocketClose,
  setStateDir,
} from "./webrtc.js";

export interface SignalingServerOptions {
  port: number;
  host?: string;
  tlsTarget?: string;
  tlsProvider?: "mkcert" | "tailscale";
  stateDir?: string;
  handshakeTimeoutMs?: number;
  logger?: Pick<Console, "log" | "warn" | "error">;
}

export interface SignalingServerRuntime {
  httpsServer: HttpsServer;
  wss: WebSocketServer;
  certFingerprint: string;
  start(): Promise<PairingBundle>;
  getPairingBundle(): PairingBundle;
  close(): Promise<void>;
}

function viewerHtml(sessionId: string, token: string): string {
  const sessionIdJson = JSON.stringify(sessionId).replace(/</gu, "\\u003c");
  const tokenJson = JSON.stringify(token).replace(/</gu, "\\u003c");

  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>DroneLink Ground Viewer</title>
    <style>
      body { margin: 0; font-family: sans-serif; background: #111; color: #eee; }
      main { padding: 12px; max-width: 960px; margin: 0 auto; }
      video { width: 100%; max-height: 80vh; background: black; }
      button { padding: 8px 12px; margin-bottom: 12px; }
      #status { margin-bottom: 12px; }
    </style>
  </head>
  <body>
    <main>
      <h1>DroneLink Ground Viewer</h1>
      <div id="status">Idle</div>
      <button id="connect" type="button">Connect viewer</button>
      <video id="viewer" autoplay playsinline controls muted></video>
    </main>
    <script>
      const statusEl = document.getElementById("status");
      const buttonEl = document.getElementById("connect");
      const videoEl = document.getElementById("viewer");
      let ws;
      let pc;

      const setStatus = (message) => {
        statusEl.textContent = message;
      };

      const cleanup = () => {
        if (pc) {
          pc.close();
          pc = undefined;
        }
        if (ws) {
          ws.close();
          ws = undefined;
        }
      };

      buttonEl.addEventListener("click", async () => {
        cleanup();
        setStatus("Connecting...");

        ws = new WebSocket(location.origin.replace(/^http/, "ws") + "/viewer-ws");
        ws.addEventListener("close", () => {
          setStatus("Disconnected");
        });
        ws.addEventListener("error", () => {
          setStatus("Viewer signaling error");
        });

        ws.addEventListener("open", async () => {
          try {
            pc = new RTCPeerConnection();
            pc.ontrack = (event) => {
              const [stream] = event.streams;
              if (stream) {
                videoEl.srcObject = stream;
                setStatus("Live video");
                return;
              }
              const fallbackStream = new MediaStream([event.track]);
              videoEl.srcObject = fallbackStream;
              setStatus("Live video");
            };

            pc.onconnectionstatechange = () => {
              if (
                pc.connectionState === "failed" ||
                pc.connectionState === "disconnected" ||
                pc.connectionState === "closed"
              ) {
                setStatus("Peer state: " + pc.connectionState);
              }
            };

            pc.onicecandidate = (event) => {
              if (event.candidate && ws && ws.readyState === WebSocket.OPEN) {
                ws.send(JSON.stringify({ type: "ice-candidate", candidate: event.candidate.toJSON() }));
              }
            };

            ws.addEventListener("message", async (messageEvent) => {
              let message;
              try {
                message = JSON.parse(messageEvent.data);
              } catch {
                setStatus("Viewer signaling parse error");
                return;
              }

              if (message.type === "pairing-accepted") {
                const offer = await pc.createOffer({ offerToReceiveVideo: true });
                await pc.setLocalDescription(offer);
                ws.send(JSON.stringify({ type: "offer", sdp: offer.sdp }));
                setStatus("Negotiating viewer session...");
                return;
              }

              if (message.type === "answer" && typeof message.sdp === "string") {
                await pc.setRemoteDescription({ type: "answer", sdp: message.sdp });
                setStatus("Waiting for video track...");
                return;
              }

              if (message.type === "ice-candidate" && message.candidate) {
                await pc.addIceCandidate(message.candidate);
              }
            });
            ws.send(JSON.stringify({ type: "pair", sessionId: ${sessionIdJson}, token: ${tokenJson} }));
            setStatus("Authorizing viewer...");
          } catch (error) {
            setStatus("Failed: " + (error instanceof Error ? error.message : String(error)));
          }
        });
      });
    </script>
  </body>
</html>`;
}

function getListeningPort(server: HttpsServer): number {
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Signaling server is not listening on a TCP port.");
  }

  return address.port;
}

export function createSignalingServer(options: SignalingServerOptions): SignalingServerRuntime {
  const host = options.host ?? "localhost";
  const tlsTarget = options.tlsTarget ?? "localhost";
  const tlsProvider = options.tlsProvider ?? "mkcert";
  const stateDir = options.stateDir ?? join(homedir(), ".dronelink-ground");
  const handshakeTimeoutMs = options.handshakeTimeoutMs ?? 5_000;
  const logger = options.logger ?? console;
  const sessionId = generateSessionId();
  const token = generateToken();

  setStateDir(stateDir);

  const tlsMaterial =
    tlsProvider === "tailscale"
      ? ensureTailscaleTlsMaterial(stateDir, tlsTarget)
      : ensureTlsMaterial(stateDir, tlsTarget);
  const httpsServer = createServer(
    {
      key: tlsMaterial.key,
      cert: tlsMaterial.cert,
    },
    (req, res) => {
      const requestPath = new URL(req.url ?? "/", "https://localhost").pathname;

      if (requestPath === "/viewer") {
        res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        res.end(viewerHtml(sessionId, token));
        return;
      }

      res.writeHead(200, { "content-type": "text/plain; charset=utf-8" });
      res.end("DroneLink signaling endpoint\n");
    },
  );

  const wss = new WebSocketServer({ noServer: true });
  const viewerWss = new WebSocketServer({ noServer: true });
  let bundle: PairingBundle | undefined;
  let startPromise: Promise<PairingBundle> | undefined;

  httpsServer.on("upgrade", (req, socket, head) => {
    const requestPath = new URL(req.url ?? "/", "https://localhost").pathname;

    if (requestPath === "/viewer-ws") {
      viewerWss.handleUpgrade(req, socket, head, (ws) => {
        viewerWss.emit("connection", ws, req);
      });
      return;
    }

    if (requestPath === "/" || requestPath === "") {
      wss.handleUpgrade(req, socket, head, (ws) => {
        wss.emit("connection", ws, req);
      });
      return;
    }

    socket.destroy();
  });

  viewerWss.on("connection", (socket) => {
    const viewerId = randomUUID();
    logger.log("Local viewer connected");
    let authenticated = false;
    const authTimeout = setTimeout(() => {
      if (!authenticated) {
        socket.close(1008, "token required");
      }
    }, handshakeTimeoutMs);

    socket.on("message", (data) => {
      let signalingMessage: unknown;
      try {
        signalingMessage = JSON.parse(data.toString());
      } catch {
        logger.warn("Received malformed local viewer signaling message");
        return;
      }

      if (!authenticated) {
        if (!isPairingRequest(signalingMessage)) {
          socket.close(1008, "token required");
          return;
        }

        if (signalingMessage.sessionId !== sessionId) {
          socket.close(1008, "invalid session");
          return;
        }

        if (signalingMessage.token !== token) {
          socket.close(1008, "invalid token");
          return;
        }

        authenticated = true;
        clearTimeout(authTimeout);
        socket.send(JSON.stringify(createPairingAcceptedMessage(sessionId)));
        return;
      }

      handleViewerSignalingMessage(viewerId, signalingMessage, (msg) => {
        socket.send(JSON.stringify(msg));
      });
    });

    socket.on("close", () => {
      clearTimeout(authTimeout);
      logger.log("Local viewer disconnected");
      handleViewerSocketClose(viewerId);
    });
  });

  wss.on("connection", (socket) => {
    logger.log("Signaling client connected");

    let authenticated = false;
    const authTimeout = setTimeout(() => {
      if (!authenticated) {
        socket.close(1008, "token required");
      }
    }, handshakeTimeoutMs);

    socket.on("message", (data) => {
      const payloadText = data.toString();

      if (!authenticated) {
        let parsed: unknown;

        try {
          parsed = JSON.parse(payloadText);
        } catch {
          socket.close(1008, "invalid auth payload");
          return;
        }

        if (!isPairingRequest(parsed)) {
          socket.close(1008, "token required");
          return;
        }

        if (parsed.sessionId !== sessionId) {
          socket.close(1008, "invalid session");
          return;
        }

        if (parsed.token !== token) {
          socket.close(1008, "invalid token");
          return;
        }

        authenticated = true;
        clearTimeout(authTimeout);
        socket.send(JSON.stringify(createPairingAcceptedMessage(sessionId)));
        return;
      }

      let signalingMessage: unknown;
      try {
        signalingMessage = JSON.parse(payloadText);
      } catch {
        logger.warn("Received malformed signaling message after auth");
        return;
      }
      handleSignalingMessage(signalingMessage, (msg) => {
        socket.send(JSON.stringify(msg));
      }, tlsProvider === "tailscale", sessionId);
    });

    socket.on("close", () => {
      clearTimeout(authTimeout);
      logger.log("Signaling client disconnected");
      if (authenticated) {
        handleSocketClose();
      }
    });
  });

  return {
    httpsServer,
    wss,
    certFingerprint: tlsMaterial.certFingerprint,
    async start(): Promise<PairingBundle> {
      if (!startPromise) {
        startPromise = new Promise<PairingBundle>((resolve, reject) => {
          const onError = (error: Error) => {
            httpsServer.off("listening", onListening);
            reject(error);
          };

          const onListening = () => {
            httpsServer.off("error", onError);
            bundle = createPairingBundle({
              sessionId,
              token,
              host,
              port: getListeningPort(httpsServer),
              certFingerprint: tlsMaterial.certFingerprint,
            });
            resolve(bundle);
          };

          httpsServer.once("error", onError);
          httpsServer.once("listening", onListening);
          httpsServer.listen(options.port, host);
        });
      }

      return startPromise;
    },
    getPairingBundle(): PairingBundle {
      if (!bundle) {
        throw new Error("Signaling server has not started yet.");
      }

      return bundle;
    },
    async close(): Promise<void> {
      await new Promise<void>((resolve, reject) => {
        viewerWss.close((viewerWssError) => {
          if (viewerWssError) {
            reject(viewerWssError);
            return;
          }

          wss.close((wssError) => {
            if (wssError) {
              reject(wssError);
              return;
            }

            httpsServer.close((serverError) => {
              if (serverError) {
                reject(serverError);
                return;
              }

              resolve();
            });
          });
        });
      });
    },
  };
}
