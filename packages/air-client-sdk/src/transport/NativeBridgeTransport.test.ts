/**
 * Tests for NativeBridgeTransport.
 *
 * Uses Node's built-in MessageChannel/MessagePort (global since Node 15) rather than a
 * hand-rolled fake — it's spec-compatible with the DOM API this class is written against
 * (postMessage/onmessage/start/close), so these tests exercise real MessagePort semantics
 * instead of a stand-in that might not behave the same way a browser's would.
 */
import { describe, it, expect } from "vitest";
import {
  NativeBridgeTransport,
  NATIVE_BRIDGE_PORT_MESSAGE,
  NATIVE_BRIDGE_PORT_RECONNECT_MESSAGE,
} from "./NativeBridgeTransport.js";

function wait(ms = 10): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe("NativeBridgeTransport", () => {
  it("exports the window-message payload constant used for the port handoff", () => {
    expect(NATIVE_BRIDGE_PORT_MESSAGE).toBe("dronelink:native-bridge-port");
  });

  it("exports a distinct payload constant for reconnect ports", () => {
    expect(NATIVE_BRIDGE_PORT_RECONNECT_MESSAGE).toBe("dronelink:native-bridge-port-reconnect");
    expect(NATIVE_BRIDGE_PORT_RECONNECT_MESSAGE).not.toBe(NATIVE_BRIDGE_PORT_MESSAGE);
  });

  // -- open() / receivePort() ordering ----------------------------------------

  it("open() resolves once receivePort() is called (port arrives after open())", async () => {
    const { port1, port2 } = new MessageChannel();
    const transport = new NativeBridgeTransport();

    const openPromise = transport.open();
    // open() should still be pending — no port yet.
    let opened = false;
    void openPromise.then(() => {
      opened = true;
    });
    await wait();
    expect(opened).toBe(false);

    transport.receivePort(port1 as unknown as MessagePort);
    await openPromise;
    expect(opened).toBe(true);

    port2.close();
    await transport.close();
  });

  it("open() resolves immediately when the port already arrived before open() was called", async () => {
    const { port1 } = new MessageChannel();
    const transport = new NativeBridgeTransport();

    transport.receivePort(port1 as unknown as MessagePort);
    await expect(transport.open()).resolves.toBeUndefined();

    await transport.close();
  });

  // -- write() -----------------------------------------------------------------

  it("write() posts exactly the view's bytes (not the whole underlying buffer) on the port", async () => {
    const { port1, port2 } = new MessageChannel();
    const transport = new NativeBridgeTransport();
    transport.receivePort(port1 as unknown as MessagePort);
    await transport.open();

    const received: unknown[] = [];
    port2.onmessage = (event) => received.push(event.data);

    // A view into the middle of a larger buffer -- write() must send only these bytes,
    // not the whole 8-byte backing buffer.
    const backing = new Uint8Array([0xaa, 0xaa, 0x24, 0x4d, 0x3c, 0xbb, 0xbb, 0xbb]);
    const view = new Uint8Array(backing.buffer, 2, 3);

    await transport.write(view);
    await wait();

    expect(received).toHaveLength(1);
    expect(new Uint8Array(received[0] as ArrayBuffer)).toEqual(new Uint8Array([0x24, 0x4d, 0x3c]));

    // The caller's view must still be valid (not transferred/detached).
    expect(view).toEqual(new Uint8Array([0x24, 0x4d, 0x3c]));

    port2.close();
    await transport.close();
  });

  it("write() throws when the transport is not open", async () => {
    const transport = new NativeBridgeTransport();
    await expect(transport.write(new Uint8Array([0x01]))).rejects.toThrow(
      "NativeBridgeTransport is not open.",
    );
  });

  // -- subscribe() / incoming data -----------------------------------------------

  it("dispatches bytes received on the port to subscribe() handlers", async () => {
    const { port1, port2 } = new MessageChannel();
    const transport = new NativeBridgeTransport();
    transport.receivePort(port1 as unknown as MessagePort);

    const received: Uint8Array[] = [];
    transport.subscribe((data) => received.push(data));
    await transport.open();

    port2.postMessage(new Uint8Array([0x01, 0x02, 0x03]).buffer);
    await wait();

    expect(received).toHaveLength(1);
    expect(received[0]).toEqual(new Uint8Array([0x01, 0x02, 0x03]));

    port2.close();
    await transport.close();
  });

  it("dispatches a zero-length chunk the same way a disconnect signal would arrive", async () => {
    const { port1, port2 } = new MessageChannel();
    const transport = new NativeBridgeTransport();
    transport.receivePort(port1 as unknown as MessagePort);

    const received: Uint8Array[] = [];
    transport.subscribe((data) => received.push(data));
    await transport.open();

    port2.postMessage(new Uint8Array(0).buffer);
    await wait();

    expect(received).toHaveLength(1);
    expect(received[0]).toHaveLength(0);

    port2.close();
    await transport.close();
  });

  it("subscribe() unsubscribe removes the handler", () => {
    const transport = new NativeBridgeTransport();
    const received: Uint8Array[] = [];
    const unsub = transport.subscribe((data) => received.push(data));
    unsub();
    expect(received).toHaveLength(0);
  });

  // -- close() -------------------------------------------------------------------

  it("close() clears the port so a subsequent write() throws again", async () => {
    const { port1 } = new MessageChannel();
    const transport = new NativeBridgeTransport();
    transport.receivePort(port1 as unknown as MessagePort);
    await transport.open();

    await transport.close();

    await expect(transport.write(new Uint8Array([0x01]))).rejects.toThrow(
      "NativeBridgeTransport is not open.",
    );
  });

  it("close() before open()/receivePort() does not throw", async () => {
    const transport = new NativeBridgeTransport();
    await expect(transport.close()).resolves.toBeUndefined();
  });

  it("messages arriving before open() is called are not lost", async () => {
    const { port1, port2 } = new MessageChannel();
    const transport = new NativeBridgeTransport();
    transport.receivePort(port1 as unknown as MessagePort);

    // Post before open()/onmessage is wired up -- MessagePort queues internally
    // until start()/onmessage assignment, per spec, so nothing should be dropped.
    port2.postMessage(new Uint8Array([0xff]).buffer);

    const received: Uint8Array[] = [];
    transport.subscribe((data) => received.push(data));
    await transport.open();
    await wait();

    expect(received).toHaveLength(1);
    expect(received[0]).toEqual(new Uint8Array([0xff]));

    port2.close();
    await transport.close();
  });
});
