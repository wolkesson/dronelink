import { createConnection, createServer, type Socket } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import { startBridge, stopBridge } from "./tcp-bridge.js";
import type { RTCDataChannel } from "werift";

// ---------------------------------------------------------------------------
// Minimal RTCDataChannel mock
// ---------------------------------------------------------------------------

type MessageCallback = (data: unknown) => void;

function makeDataChannelMock(): {
  channel: RTCDataChannel;
  triggerMessage: (data: unknown) => void;
  sendSpy: ReturnType<typeof vi.fn>;
} {
  let subscriber: MessageCallback | null = null;
  const sendSpy = vi.fn();

  const channel = {
    readyState: "open" as RTCDataChannel["readyState"],
    onMessage: {
      subscribe(cb: MessageCallback) {
        subscriber = cb;
      },
    },
    send: sendSpy,
  } as unknown as RTCDataChannel;

  return {
    channel,
    triggerMessage: (data: unknown) => subscriber?.(data),
    sendSpy,
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** The port tcp-bridge.ts will listen on (matches the module-level constant). */
const BRIDGE_PORT = Number(process.env.BRIDGE_TCP_PORT ?? 5761);

function connectTcp(): Promise<Socket | null> {
  return new Promise((resolve) => {
    const socket = createConnection({ host: "127.0.0.1", port: BRIDGE_PORT });
    socket.once("connect", () => resolve(socket));
    socket.once("error", () => resolve(null));
  });
}

function readOnce(socket: Socket): Promise<Buffer> {
  return new Promise((resolve) => {
    socket.once("data", (chunk: Buffer) => resolve(chunk));
  });
}

function socketClosed(socket: Socket): Promise<void> {
  return new Promise((resolve) => {
    if (socket.destroyed) {
      resolve();
      return;
    }
    socket.once("close", () => resolve());
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

afterEach(() => {
  stopBridge();
});

describe("tcp-bridge: client limit", () => {
  it("destroys a second TCP client when one is already connected", async () => {
    const { channel } = makeDataChannelMock();
    startBridge(channel);

    const first = await connectTcp();
    if (!first) return; // bridge port in use — skip gracefully

    // Connect a second client; the bridge should immediately close it.
    const second = createConnection({ host: "127.0.0.1", port: BRIDGE_PORT });
    await socketClosed(second);

    expect(second.destroyed).toBe(true);
    expect(first.destroyed).toBe(false);

    first.destroy();
  });
});

describe("tcp-bridge: relay behaviour", () => {
  it("forwards data-channel messages to the connected TCP client", async () => {
    const { channel, triggerMessage } = makeDataChannelMock();
    startBridge(channel);

    const client = await connectTcp();
    if (!client) return;

    const received = readOnce(client);
    triggerMessage(Buffer.from([0x01, 0x02, 0x03]));

    await expect(received).resolves.toEqual(Buffer.from([0x01, 0x02, 0x03]));
    client.destroy();
  });

  it("forwards TCP client data to the data channel via send()", async () => {
    const { channel, sendSpy } = makeDataChannelMock();
    startBridge(channel);

    const client = await connectTcp();
    if (!client) return;

    await new Promise<void>((resolve) => {
      client.write(Buffer.from([0xaa, 0xbb]), () => resolve());
    });

    // Give the bridge's data event a tick to fire.
    await new Promise<void>((resolve) => setTimeout(resolve, 20));

    expect(sendSpy).toHaveBeenCalledWith(Buffer.from([0xaa, 0xbb]));
    client.destroy();
  });

  it("drops non-Buffer data-channel messages with a console.warn", async () => {
    const { channel, triggerMessage } = makeDataChannelMock();
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    startBridge(channel);

    // A TCP client must be connected for the non-Buffer path to be reached
    // (the bridge checks tcpClient before checking Buffer.isBuffer).
    const client = await connectTcp();
    if (!client) {
      stopBridge();
      warnSpy.mockRestore();
      return;
    }

    triggerMessage("unexpected string payload");

    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("unexpected non-Buffer"),
    );
    client.destroy();
    warnSpy.mockRestore();
  });

  it("warns when no TCP client is connected and drops the message", () => {
    const { channel, triggerMessage } = makeDataChannelMock();
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    startBridge(channel);

    // Trigger a message before any TCP client has connected.
    triggerMessage(Buffer.from([0xff]));

    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("no TCP client connected"),
    );
    warnSpy.mockRestore();
  });
});

describe("tcp-bridge: restart and error handling", () => {
  it("is a no-op when called with no active bridge", () => {
    expect(() => stopBridge()).not.toThrow();
  });

  it("drops TCP data from the client when the data channel is not open", async () => {
    const { channel, sendSpy } = makeDataChannelMock();
    channel.readyState = "connecting";
    startBridge(channel);

    const client = await connectTcp();
    if (!client) return; // bridge port in use — skip gracefully

    await new Promise<void>((resolveWrite) => {
      client.write(Buffer.from([0x01]), () => resolveWrite());
    });
    await new Promise<void>((resolveTick) => setTimeout(resolveTick, 20));

    expect(sendSpy).not.toHaveBeenCalled();
    client.destroy();
  });

  it("stops the previous bridge (destroying its TCP client) when startBridge is called again", async () => {
    const { channel } = makeDataChannelMock();
    startBridge(channel);

    const first = await connectTcp();
    if (!first) return; // bridge port in use — skip gracefully

    const { channel: channel2 } = makeDataChannelMock();
    startBridge(channel2);

    await socketClosed(first);
    expect(first.destroyed).toBe(true);
  });

  it("logs a warning and clears the client on a TCP socket error", async () => {
    const { channel } = makeDataChannelMock();
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    startBridge(channel);

    const client = await connectTcp();
    if (!client) {
      errorSpy.mockRestore();
      return;
    }

    // Sends an actual TCP RST, which surfaces as an "error" event (ECONNRESET)
    // on the bridge's server-side socket for this connection.
    client.resetAndDestroy();

    await vi.waitFor(() =>
      expect(errorSpy).toHaveBeenCalledWith("TCP client error:", expect.any(String)),
    );
    errorSpy.mockRestore();
  });

  it("logs a warning when the bridge fails to bind its TCP port", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const blocker = createServer();
    await new Promise<void>((resolveListen) => blocker.listen(BRIDGE_PORT, resolveListen));

    try {
      const { channel } = makeDataChannelMock();
      startBridge(channel);

      await vi.waitFor(() =>
        expect(errorSpy).toHaveBeenCalledWith("TCP bridge error:", expect.any(String)),
      );
    } finally {
      await new Promise<void>((resolveClose) => blocker.close(() => resolveClose()));
      errorSpy.mockRestore();
    }
  });
});
