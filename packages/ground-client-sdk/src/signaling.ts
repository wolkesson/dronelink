import { createServer, type Server as HttpsServer } from "node:https";
import type { IncomingMessage, ServerResponse } from "node:http";
import { homedir } from "node:os";
import { join } from "node:path";
import { WebSocketServer, type WebSocket } from "ws";
import {
  createPairingAcceptedMessage,
  createPairingBundle,
  generateSessionId,
  generateToken,
  isPairingRequest,
  type PairingBundle,
} from "@dronelink/core-transport";
import { ensureTailscaleTlsMaterial, ensureTlsMaterial } from "@dronelink/core-transport/node";
import {
  handleGuiSignalingMessage,
  handleGuiSocketClose,
  handleSignalingMessage,
  handleSocketClose,
  setStateDir,
} from "./webrtc.js";

export interface GuiAssets {
  page: string;
  clientScript: string;
}

export interface SignalingServerOptions {
  port: number;
  host?: string;
  tlsTarget?: string;
  tlsProvider?: "mkcert" | "tailscale";
  stateDir?: string;
  handshakeTimeoutMs?: number;
  logger?: Pick<Console, "log" | "warn" | "error">;
  guiAssets?: GuiAssets;
  sessionId?: string;
  token?: string;
}

export interface SignalingServerRuntime {
  httpsServer: HttpsServer;
  wss: WebSocketServer;
  guiWss: WebSocketServer;
  start(): Promise<PairingBundle>;
  getPairingBundle(): PairingBundle;
  close(): Promise<void>;
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
  const guiAssets = options.guiAssets;
  const sessionId = options.sessionId ?? generateSessionId();
  const token = options.token ?? generateToken();

  setStateDir(stateDir);
  console.log(`Signaling server state directory: ${stateDir}`);

  const tlsMaterial =
    tlsProvider === "tailscale"
      ? ensureTailscaleTlsMaterial(stateDir, tlsTarget)
      : ensureTlsMaterial(stateDir, tlsTarget);
  const httpsServer = createServer(
    {
      key: tlsMaterial.key,
      cert: tlsMaterial.cert,
    },
    (req: IncomingMessage, res: ServerResponse) => {
      if (req.url === "/gui" || req.url === "/gui-client.js") {
        if (!guiAssets) {
          res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
          res.end("Ground GUI assets are unavailable.\n");
          return;
        }
        const isPage = req.url === "/gui";
        res.writeHead(200, {
          "content-type": isPage ? "text/html; charset=utf-8" : "text/javascript; charset=utf-8",
        });
        res.end(isPage ? guiAssets.page : guiAssets.clientScript);
        return;
      }
      res.writeHead(200, { "content-type": "text/plain; charset=utf-8" });
      res.end("DroneLink signaling endpoint\n");
    },
  );

  const wss = new WebSocketServer({ noServer: true });
  const guiWss = new WebSocketServer({ noServer: true });
  let bundle: PairingBundle | undefined;
  let startPromise: Promise<PairingBundle> | undefined;

  const configureAirSignalingSocket = (socket: WebSocket) => {
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
          socket.close(1008, "invalid session id");
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

      let signalingMessage: Record<string, unknown>;
      try {
        signalingMessage = JSON.parse(payloadText);
      } catch {
        logger.warn("Received malformed signaling message after auth");
        return;
      }
      handleSignalingMessage(signalingMessage, (msg) => {
        socket.send(JSON.stringify(msg));
      }, tlsProvider === "tailscale");
    });

    socket.on("close", () => {
      clearTimeout(authTimeout);
      logger.log("Signaling client disconnected");
      if (authenticated) {
        handleSocketClose();
      }
    });
  };

  wss.on("connection", configureAirSignalingSocket);
  guiWss.on("connection", (socket) => {
    socket.on("message", (data) => {
      let signalingMessage: unknown;
      try {
        signalingMessage = JSON.parse(data.toString());
      } catch {
        logger.warn("Received malformed GUI signaling message");
        return;
      }
      handleGuiSignalingMessage(signalingMessage, (msg) => {
        socket.send(JSON.stringify(msg));
      }, tlsProvider === "tailscale");
    });

    socket.on("close", () => {
      handleGuiSocketClose();
    });
  });

  httpsServer.on("upgrade", (request, socket, head) => {
    const path = new URL(request.url ?? "/", "https://localhost").pathname;
    if (path === "/gui-signaling") {
      guiWss.handleUpgrade(request, socket, head, (guiSocket) => {
        guiWss.emit("connection", guiSocket, request);
      });
      return;
    }
    if (path === "/") {
      wss.handleUpgrade(request, socket, head, (signalingSocket) => {
        wss.emit("connection", signalingSocket, request);
      });
      return;
    }
    socket.destroy();
  });

  return {
    httpsServer,
    wss,
    guiWss,
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
        wss.close((wssError) => {
          if (wssError) {
            reject(wssError);
            return;
          }
          guiWss.close((guiWssError) => {
            if (guiWssError) {
              reject(guiWssError);
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
