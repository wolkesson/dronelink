/**
 * Tests for WebSerialTransport.
 *
 * navigator.serial is only available in secure browser contexts (desktop Chrome / Edge).
 * These tests run in Node/Vitest with a hand-rolled fake SerialPort to keep them
 * environment-independent.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { WebSerialTransport } from "./WebSerialTransport.js";

// ---------------------------------------------------------------------------
// Fake Web Serial API helpers
// ---------------------------------------------------------------------------

/** Creates a ReadableStream that yields the supplied chunks in order, then closes. */
function makeReadable(chunks: Uint8Array[]): ReadableStream<Uint8Array> {
  let i = 0;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (i < chunks.length) {
        controller.enqueue(chunks[i++]);
      } else {
        controller.close();
      }
    },
  });
}

/** Creates a ReadableStream that yields one chunk then throws a NetworkError. */
function makeDisconnectingReadable(firstChunk: Uint8Array): ReadableStream<Uint8Array> {
  let yielded = false;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (!yielded) {
        yielded = true;
        controller.enqueue(firstChunk);
      } else {
        throw new DOMException("Device disconnected", "NetworkError");
      }
    },
  });
}

/** Creates a WritableStream that records all written chunks and exposes them via `written`. */
function makeWritable(): { writable: WritableStream<Uint8Array>; written: Uint8Array[] } {
  const written: Uint8Array[] = [];
  const writable = new WritableStream<Uint8Array>({
    write(chunk) {
      written.push(chunk);
    },
  });
  return { writable, written };
}

interface FakeSerialPort {
  open: ReturnType<typeof vi.fn>;
  close: ReturnType<typeof vi.fn>;
  readable: ReadableStream<Uint8Array>;
  writable: WritableStream<Uint8Array>;
  _written: Uint8Array[];
}

function makeFakePort(readable: ReadableStream<Uint8Array>): FakeSerialPort {
  const { writable, written } = makeWritable();
  return {
    open: vi.fn().mockResolvedValue(undefined),
    close: vi.fn().mockResolvedValue(undefined),
    readable,
    writable,
    _written: written,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("WebSerialTransport", () => {
  beforeEach(() => {
    // Reset navigator.serial before each test.
    Object.defineProperty(globalThis, "navigator", {
      value: { serial: undefined },
      configurable: true,
      writable: true,
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // -- open() ----------------------------------------------------------------

  it("open() throws when navigator.serial is unavailable", async () => {
    const transport = new WebSerialTransport();
    await expect(transport.open()).rejects.toThrow("Web Serial API is not available");
  });

  it("open() calls requestPort() with no filters and opens at 115200", async () => {
    const fakePort = makeFakePort(makeReadable([]));
    const requestPort = vi.fn().mockResolvedValue(fakePort);
    Object.defineProperty(globalThis, "navigator", {
      value: { serial: { requestPort } },
      configurable: true,
      writable: true,
    });

    const transport = new WebSerialTransport();
    await transport.open();

    expect(requestPort).toHaveBeenCalledWith();
    expect(fakePort.open).toHaveBeenCalledWith({ baudRate: 115200 });
    await transport.close();
  });

  // -- write() — persistent writer -------------------------------------------

  it("write() sends bytes through the persistent writer acquired at open()", async () => {
    const fakePort = makeFakePort(makeReadable([]));
    const requestPort = vi.fn().mockResolvedValue(fakePort);
    Object.defineProperty(globalThis, "navigator", {
      value: { serial: { requestPort } },
      configurable: true,
      writable: true,
    });

    const transport = new WebSerialTransport();
    await transport.open();

    const chunk = new Uint8Array([0x24, 0x4d, 0x3c, 0x00, 0x01, 0x01]);
    await transport.write(chunk);
    await transport.write(new Uint8Array([0xff]));

    // Both writes go through the same underlying WritableStream (not via releaseLock each time).
    expect(fakePort._written).toHaveLength(2);
    expect(fakePort._written[0]).toEqual(chunk);
    expect(fakePort._written[1]).toEqual(new Uint8Array([0xff]));

    await transport.close();
  });

  it("write() throws when the port is not open", async () => {
    const transport = new WebSerialTransport();
    await expect(transport.write(new Uint8Array([0x01]))).rejects.toThrow(
      "Serial port is not open.",
    );
  });

  // -- subscribe() / read loop -----------------------------------------------

  it("dispatches received chunks to subscribe() handlers", async () => {
    const chunks = [new Uint8Array([0x24, 0x4d]), new Uint8Array([0x01, 0x02, 0x03])];
    const fakePort = makeFakePort(makeReadable(chunks));
    const requestPort = vi.fn().mockResolvedValue(fakePort);
    Object.defineProperty(globalThis, "navigator", {
      value: { serial: { requestPort } },
      configurable: true,
      writable: true,
    });

    const transport = new WebSerialTransport();
    const received: Uint8Array[] = [];
    transport.subscribe((data) => received.push(data));

    await transport.open();
    // Give the read loop a chance to drain the fake stream.
    await new Promise((r) => setTimeout(r, 10));

    expect(received).toHaveLength(2);
    expect(received[0]).toEqual(new Uint8Array([0x24, 0x4d]));
    expect(received[1]).toEqual(new Uint8Array([0x01, 0x02, 0x03]));
    await transport.close();
  });

  it("dispatches a zero-length chunk on NetworkError (device disconnect)", async () => {
    const fakePort = makeFakePort(
      makeDisconnectingReadable(new Uint8Array([0xff])),
    );
    const requestPort = vi.fn().mockResolvedValue(fakePort);
    Object.defineProperty(globalThis, "navigator", {
      value: { serial: { requestPort } },
      configurable: true,
      writable: true,
    });

    const transport = new WebSerialTransport();
    const received: Uint8Array[] = [];
    transport.subscribe((data) => received.push(data));

    await transport.open();
    await new Promise((r) => setTimeout(r, 10));

    // First chunk dispatched normally; second dispatch is the zero-length disconnect signal.
    expect(received.length).toBeGreaterThanOrEqual(2);
    expect(received[0]).toEqual(new Uint8Array([0xff]));
    expect(received[received.length - 1]).toHaveLength(0);
    await transport.close();
  });

  it("subscribe() unsubscribe removes the handler", () => {
    const transport = new WebSerialTransport();
    const received: Uint8Array[] = [];
    const unsub = transport.subscribe((data) => received.push(data));
    unsub();
    // No chunks dispatched after unsubscribing.
    expect(received).toHaveLength(0);
  });

  // -- close() ---------------------------------------------------------------

  it("close() calls port.close()", async () => {
    const fakePort = makeFakePort(makeReadable([]));
    const requestPort = vi.fn().mockResolvedValue(fakePort);
    Object.defineProperty(globalThis, "navigator", {
      value: { serial: { requestPort } },
      configurable: true,
      writable: true,
    });

    const transport = new WebSerialTransport();
    await transport.open();
    await transport.close();

    expect(fakePort.close).toHaveBeenCalled();
  });

  it("close() before open() does not throw", async () => {
    const transport = new WebSerialTransport();
    await expect(transport.close()).resolves.toBeUndefined();
  });
});
