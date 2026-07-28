import { createServer as createHttpServer, type Server as HttpServer } from "node:http";
import { createServer as createHttpsServer, type Server as HttpsServer } from "node:https";
import { homedir } from "node:os";
import { join } from "node:path";
import { WebSocketServer } from "ws";
import {
  createPairingAcceptedMessage,
  createPairingBundle,
  ensureTlsMaterial,
  generateSessionId,
  generateToken,
  isPairingRequest,
  type PairingBundle,
} from "./pairing.js";
import { handleSignalingMessage, handleSocketClose } from "./webrtc.js";

export interface SignalingServerOptions {
  port: number;
  host?: string;
  tlsTarget?: string;
  skipPairingAuth?: boolean;
  stateDir?: string;
  handshakeTimeoutMs?: number;
  logger?: Pick<Console, "log" | "warn" | "error">;
}

export interface SignalingServerRuntime {
  httpsServer: HttpServer | HttpsServer;
  wss: WebSocketServer;
  certFingerprint: string;
  start(): Promise<PairingBundle>;
  getPairingBundle(): PairingBundle;
  close(): Promise<void>;
}

type SignalingServer = HttpServer | HttpsServer;

function getListeningPort(server: SignalingServer): number {
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Signaling server is not listening on a TCP port.");
  }

  return address.port;
}

export function createSignalingServer(options: SignalingServerOptions): SignalingServerRuntime {
  const host = options.host ?? "localhost";
  const tlsTarget = options.tlsTarget ?? "localhost";
  const skipPairingAuth = options.skipPairingAuth ?? false;
  const stateDir = options.stateDir ?? join(homedir(), ".dronelink-ground");
  const handshakeTimeoutMs = options.handshakeTimeoutMs ?? 5_000;
  const logger = options.logger ?? console;
  const sessionId = generateSessionId();
  const token = generateToken();
  let tlsFingerprint = "";
  let server: SignalingServer;

  if (skipPairingAuth) {
   server = createHttpServer((_req, res) => {
     res.writeHead(200, { "content-type": "text/plain; charset=utf-8" });
     res.end("DroneLink signaling endpoint\n");
   });
  } else {
   const tlsMaterial = ensureTlsMaterial(stateDir, tlsTarget);
   tlsFingerprint = tlsMaterial.certFingerprint;
   server = createHttpsServer(
     {
       key: tlsMaterial.key,
       cert: tlsMaterial.cert,
     },
     (_req, res) => {
       res.writeHead(200, { "content-type": "text/plain; charset=utf-8" });
       res.end("DroneLink signaling endpoint\n");
     },
   );
  }

  const wss = new WebSocketServer({ server });
  let bundle: PairingBundle | undefined;
  let startPromise: Promise<PairingBundle> | undefined;

  wss.on("connection", (socket) => {
    logger.log("Signaling client connected");

    let authenticated = false;
    const authTimeout = skipPairingAuth
      ? undefined
      : setTimeout(() => {
          if (!authenticated) {
            socket.close(1008, "token required");
          }
        }, handshakeTimeoutMs);

    socket.on("message", (data) => {
      const payloadText = data.toString();

      if (!authenticated) {
        if (skipPairingAuth) {
          authenticated = true;
          if (authTimeout) {
            clearTimeout(authTimeout);
          }
          socket.send(JSON.stringify(createPairingAcceptedMessage(sessionId)));
          return;
        }

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
      });
    });

    socket.on("close", () => {
      if (authTimeout) {
        clearTimeout(authTimeout);
      }
      logger.log("Signaling client disconnected");
      if (authenticated) {
        handleSocketClose();
      }
    });
  });

  return {
    httpsServer: server,
    wss,
    certFingerprint: tlsFingerprint,
    async start(): Promise<PairingBundle> {
      if (!startPromise) {
        startPromise = new Promise<PairingBundle>((resolve, reject) => {
          const onError = (error: Error) => {
            server.off("listening", onListening);
            reject(error);
          };

          const onListening = () => {
            server.off("error", onError);
            bundle = createPairingBundle({
              sessionId,
              token,
              host,
              port: getListeningPort(server),
              certFingerprint: tlsFingerprint,
            });
            resolve(bundle);
          };

          server.once("error", onError);
          server.once("listening", onListening);
          server.listen(options.port, host);
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

          server.close((serverError) => {
            if (serverError) {
              reject(serverError);
              return;
            }

            resolve();
          });
        });
      });
    },
  };
}
