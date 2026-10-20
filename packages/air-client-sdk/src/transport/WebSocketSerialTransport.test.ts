import { describe, it, expect } from "vitest";
import { WebSocketSerialTransport } from "./WebSocketSerialTransport.js";

class FakeWebSocket {
  static instances: FakeWebSocket[] = [];
  readyState = 0;
  binaryType = "blob";
  sent: Uint8Array[] = [];
  closeCalls = 0;
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onclose: (() => void) | null = null;

  constructor(readonly url: string) {
    FakeWebSocket.instances.push(this);
  }

  send(data: Uint8Array): void {
    this.sent.push(data);
  }

  close(): void {
    this.closeCalls++;
  }

  serverOpen(): void {
    this.readyState = 1;
    this.onopen?.();
  }

  serverMessage(data: unknown): void {
    this.onmessage?.({ data });
  }

  serverClose(): void {
    this.readyState = 3;
    this.onclose?.();
  }
}

function makeTransport(): { transport: WebSocketSerialTransport; socket: () => FakeWebSocket } {
  FakeWebSocket.instances = [];
  const transport = new WebSocketSerialTransport(
    "ws://localhost:5770",
    FakeWebSocket as unknown as new (url: string) => WebSocket,
  );
  return { transport, socket: () => FakeWebSocket.instances[FakeWebSocket.instances.length - 1] };
}

async function openTransport() {
  const t = makeTransport();
  const opening = t.transport.open();
  t.socket().serverOpen();
  await opening;
  return t;
}

describe("WebSocketSerialTransport", () => {
  it("connects to the bridge URL in binary mode and resolves once open", async () => {
    const { socket } = await openTransport();
    expect(socket().url).toBe("ws://localhost:5770");
    expect(socket().binaryType).toBe("arraybuffer");
  });

  it("rejects open() when the bridge refuses the connection", async () => {
    const { transport, socket } = makeTransport();
    const opening = transport.open();
    socket().serverClose();
    await expect(opening).rejects.toThrow("Could not connect to serial bridge at ws://localhost:5770.");
    await expect(transport.write(new Uint8Array([1]))).rejects.toThrow("Serial bridge is not connected.");
  });

  it("refuses a second open() while connected", async () => {
    const { transport } = await openTransport();
    await expect(transport.open()).rejects.toThrow("already open");
  });

  it("forwards binary messages to subscribers and ignores empty or non-binary ones", async () => {
    const { transport, socket } = await openTransport();
    const received: number[][] = [];
    const unsubscribe = transport.subscribe((bytes) => received.push([...bytes]));

    socket().serverMessage(new Uint8Array([0x24, 0x4d, 0x3e]).buffer);
    socket().serverMessage(new ArrayBuffer(0));
    socket().serverMessage("text frame");
    unsubscribe();
    socket().serverMessage(new Uint8Array([9]).buffer);

    expect(received).toEqual([[0x24, 0x4d, 0x3e]]);
  });

  it("writes bytes as binary messages", async () => {
    const { transport, socket } = await openTransport();
    await transport.write(new Uint8Array([1, 2, 3]));
    expect(socket().sent.map((b) => [...b])).toEqual([[1, 2, 3]]);
  });

  it("refuses writes before open()", async () => {
    const { transport } = makeTransport();
    await expect(transport.write(new Uint8Array([1]))).rejects.toThrow("Serial bridge is not connected.");
  });

  it("reports a bridge-side close as a zero-length chunk and stops accepting writes", async () => {
    const { transport, socket } = await openTransport();
    const received: Uint8Array[] = [];
    transport.subscribe((bytes) => received.push(bytes));

    socket().serverClose();

    expect(received).toHaveLength(1);
    expect(received[0].length).toBe(0);
    await expect(transport.write(new Uint8Array([1]))).rejects.toThrow("Serial bridge is not connected.");
  });

  it("does not report a disconnect for its own close(), and can reopen", async () => {
    const { transport, socket } = await openTransport();
    const received: Uint8Array[] = [];
    transport.subscribe((bytes) => received.push(bytes));
    const first = socket();

    await transport.close();
    expect(first.closeCalls).toBe(1);

    const reopening = transport.open();
    const second = socket();
    second.serverOpen();
    await reopening;
    first.serverClose();

    expect(received).toHaveLength(0);
    await transport.write(new Uint8Array([7]));
    expect(second.sent.map((b) => [...b])).toEqual([[7]]);
  });

  it("rejects a pending open() that close() aborts", async () => {
    const { transport, socket } = makeTransport();
    const opening = transport.open();
    await transport.close();
    socket().serverClose();
    await expect(opening).rejects.toThrow("Could not connect");
  });

  it("treats close() without an open socket as a no-op", async () => {
    const { transport } = makeTransport();
    await expect(transport.close()).resolves.toBeUndefined();
  });
});
