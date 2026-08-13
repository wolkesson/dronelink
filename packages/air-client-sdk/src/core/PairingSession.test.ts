import { describe, expect, it } from "vitest";
import { PairingSession, type PairingBundle, type PairingSocket, type PairingSocketFactory } from "./PairingSession.js";

class FakePairingSocket implements PairingSocket {
  private openHandler: (() => void) | null = null;

  private messageHandler: ((data: string) => void) | null = null;

  private errorHandler: ((error: unknown) => void) | null = null;

  private closeHandler: ((event: { code: number; reason: string }) => void) | null = null;

  private readonly behavior: (firstMessage: string, socket: FakePairingSocket) => void;

  sentMessages: string[] = [];

  constructor(behavior: (firstMessage: string, socket: FakePairingSocket) => void) {
    this.behavior = behavior;
    queueMicrotask(() => {
      this.openHandler?.();
    });
  }

  send(data: string): void {
    this.sentMessages.push(data);
    this.behavior(data, this);
  }

  close(code = 1000, reason = ""): void {
    this.closeHandler?.({ code, reason });
  }

  onOpen(handler: () => void): void {
    this.openHandler = handler;
  }

  onMessage(handler: (data: string) => void): void {
    this.messageHandler = handler;
  }

  onError(handler: (error: unknown) => void): void {
    this.errorHandler = handler;
  }

  onClose(handler: (event: { code: number; reason: string }) => void): void {
    this.closeHandler = handler;
  }

  accept(sessionId: string): void {
    this.messageHandler?.(
      JSON.stringify({
        type: "pairing-accepted",
        sessionId,
      }),
    );
  }

  fail(code: number, reason: string): void {
    this.closeHandler?.({ code, reason });
  }

  raiseError(error: unknown): void {
    this.errorHandler?.(error);
  }
}

function createBundle(overrides: Partial<PairingBundle> = {}): PairingBundle {
  return {
    sessionId: "session-1",
    token: "1234567890abcdefABCDEF",
    host: "localhost",
    port: 8443,
    ...overrides,
  };
}

function createSocketFactory(behavior: (firstMessage: string, socket: FakePairingSocket) => void): PairingSocketFactory {
  return () => new FakePairingSocket(behavior);
}

describe("PairingSession", () => {
  it("starts in UNPAIRED state", () => {
    const session = new PairingSession();
    expect(session.state).toBe("UNPAIRED");
  });

  it("connects with a valid pairing bundle and becomes PAIRED", async () => {
    const bundle = createBundle();
    const session = new PairingSession({
      socketFactory: createSocketFactory((firstMessage, socket) => {
        const parsed = JSON.parse(firstMessage) as { sessionId: string; token: string; type: string };
        expect(parsed.type).toBe("pair");
        expect(parsed.sessionId).toBe(bundle.sessionId);
        expect(parsed.token).toBe(bundle.token);
        socket.accept(bundle.sessionId);
      }),
    });

    await expect(session.pair(JSON.stringify(bundle))).resolves.toBeUndefined();
    expect(session.state).toBe("PAIRED");
    expect(session.error).toBeNull();
  });

  it("surfaces a wrong token as a pairing failure instead of hanging", async () => {
    const bundle = createBundle();
    const session = new PairingSession({
      socketFactory: createSocketFactory((firstMessage, socket) => {
        const parsed = JSON.parse(firstMessage) as { token: string };
        if (parsed.token !== bundle.token) {
          socket.fail(1008, "invalid token");
          return;
        }

        socket.accept(bundle.sessionId);
      }),
    });

    await expect(
      session.pair(
        JSON.stringify({
          ...bundle,
          token: "1234567890abcdefABCDEA",
        }),
      ),
    ).rejects.toThrow("Pairing failed: invalid token");

    expect(session.state).toBe("FAILED");
    expect(session.error).toBe("Pairing failed: invalid token");
  });
});
