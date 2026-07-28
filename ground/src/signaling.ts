import { createServer, type Server as HttpsServer } from "node:https";
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

export interface SignalingServerOptions {
  port: number;
  host?: string;
  tlsTarget?: string;
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
  const stateDir = options.stateDir ?? join(homedir(), ".dronelink-ground");
  const handshakeTimeoutMs = options.handshakeTimeoutMs ?? 5_000;
  const logger = options.logger ?? console;
  const tlsMaterial = ensureTlsMaterial(stateDir, tlsTarget);
  const sessionId = generateSessionId();
  const token = generateToken();

  const httpsServer = createServer(
    {
      key: tlsMaterial.key,
      cert: tlsMaterial.cert,
    },
    (_req, res) => {
      res.writeHead(200, { "content-type": "text/plain; charset=utf-8" });
      res.end("DroneLink signaling endpoint\n");
    },
  );

  const wss = new WebSocketServer({ server: httpsServer });
  let bundle: PairingBundle | undefined;
  let startPromise: Promise<PairingBundle> | undefined;

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

      logger.log("Ignoring signaling message until SDP/ICE exchange is implemented:", payloadText);
    });

    socket.on("close", () => {
      clearTimeout(authTimeout);
      logger.log("Signaling client disconnected");
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
    },
  };
}
