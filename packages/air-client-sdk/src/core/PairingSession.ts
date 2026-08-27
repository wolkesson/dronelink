import { isPairingBundle, type PairingBundle } from "@dronelink/core-transport";

export type PairingState = "UNPAIRED" | "AUTHENTICATING" | "PAIRED" | "FAILED";
export type { PairingBundle } from "@dronelink/core-transport";

export interface PairingSocket {
  send(data: string): void;
  close(code?: number, reason?: string): void;
  onOpen(handler: () => void): void;
  onMessage(handler: (data: string) => void): void;
  onError(handler: (error: unknown) => void): void;
  onClose(handler: (event: { code: number; reason: string }) => void): void;
}

export type PairingSocketFactory = (url: string) => PairingSocket;

export interface PairingSessionOptions {
  socketFactory?: PairingSocketFactory;
  handshakeTimeoutMs?: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function toErrorMessage(error: unknown): string {
  if (error instanceof Error && error.message.length > 0) {
    return error.message;
  }

  return (
    "Couldn't reach the ground station. Confirm the ground process is running, the phone has " +
    "network/Tailscale connectivity to it, and (if using a self-signed mkcert certificate " +
    "instead of a Tailscale-issued one) that this browser has been made to trust it."
  );
}

function createBrowserSocket(url: string): PairingSocket {
  const socket = new WebSocket(url);

  return {
    send(data: string): void {
      socket.send(data);
    },
    close(code?: number, reason?: string): void {
      socket.close(code, reason);
    },
    onOpen(handler: () => void): void {
      socket.addEventListener("open", () => handler());
    },
    onMessage(handler: (data: string) => void): void {
      socket.addEventListener("message", (event) => handler(String(event.data)));
    },
    onError(handler: (error: unknown) => void): void {
      socket.addEventListener("error", (event) => handler(event));
    },
    onClose(handler: (event: { code: number; reason: string }) => void): void {
      socket.addEventListener("close", (event) =>
        handler({
          code: event.code,
          reason: event.reason,
        }),
      );
    },
  };
}

export class PairingSession {
  private readonly socketFactory: PairingSocketFactory;

  private readonly handshakeTimeoutMs: number;

  private _state: PairingState = "UNPAIRED";

  private _error: string | null = null;

  private _bundle: PairingBundle | null = null;

  private _socket: PairingSocket | null = null;

  constructor(options: PairingSessionOptions = {}) {
    this.socketFactory = options.socketFactory ?? createBrowserSocket;
    this.handshakeTimeoutMs = options.handshakeTimeoutMs ?? 5_000;
  }

  get state(): PairingState {
    return this._state;
  }

  get error(): string | null {
    return this._error;
  }

  get bundle(): PairingBundle | null {
    return this._bundle;
  }

  get socket(): PairingSocket | null {
    return this._socket;
  }

  async pair(input: string | PairingBundle): Promise<void> {
    const bundle = this.parseBundle(input);
    this._state = "AUTHENTICATING";
    this._error = null;
    this._bundle = bundle;

    await new Promise<void>((resolve, reject) => {
      const socket = this.socketFactory(`wss://${bundle.host}:${String(bundle.port)}`);
      this._socket = socket;
      let settled = false;

      const fail = (message: string) => {
        if (settled) {
          return;
        }

        settled = true;
        clearTimeout(timeout);
        this._state = "FAILED";
        this._error = message;
        this._socket = null;
        reject(new Error(message));
      };

      const succeed = () => {
        if (settled) {
          return;
        }

        settled = true;
        clearTimeout(timeout);
        this._state = "PAIRED";
        resolve();
      };

      const timeout = setTimeout(() => {
        socket.close(1008, "pairing timeout");
        fail("Pairing failed: timed out waiting for the ground station.");
      }, this.handshakeTimeoutMs);

      socket.onOpen(() => {
        socket.send(
          JSON.stringify({
            type: "pair",
            sessionId: bundle.sessionId,
            token: bundle.token,
          }),
        );
      });

      socket.onMessage((message) => {
        let parsed: unknown;

        try {
          parsed = JSON.parse(message);
        } catch {
          fail("Pairing failed: received a malformed server response.");
          return;
        }

        if (
          isRecord(parsed) &&
          parsed.type === "pairing-accepted" &&
          parsed.sessionId === bundle.sessionId
        ) {
          succeed();
          return;
        }

        fail("Pairing failed: ground station rejected the pairing request.");
      });

      socket.onError((error) => {
        fail(toErrorMessage(error));
      });

      socket.onClose((event) => {
        if (settled) {
          return;
        }

        const reason = event.reason.length > 0 ? event.reason : "connection closed";
        fail(`Pairing failed: ${reason}`);
      });
    });
  }

  private parseBundle(input: string | PairingBundle): PairingBundle {
    let parsed: unknown;

    try {
      parsed = typeof input === "string" ? JSON.parse(input) : input;
    } catch {
      throw new Error("Invalid pairing bundle JSON.");
    }

    if (!isPairingBundle(parsed)) {
      throw new Error("Invalid pairing bundle JSON.");
    }

    return parsed;
  }
}
