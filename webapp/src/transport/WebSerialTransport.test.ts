/**
 * Placeholder tests for WebSerialTransport.
 *
 * These tests are intentionally failing until the implementation is complete (Phase 0 spike).
 *
 * TODO (Phase 0 serial spike):
 *   - Mock navigator.serial (e.g., with a fake SerialPort stub) so these tests can run in Node/Vitest.
 *   - Assert that open() calls navigator.serial.requestPort() and port.open().
 *   - Assert that write() sends bytes through port.writable.
 *   - Assert that subscribe() receives bytes pumped from port.readable.
 *   - Assert that close() tears down the reader loop and releases the port.
 */
import { describe, it, expect } from "vitest";
import { WebSerialTransport } from "./WebSerialTransport.js";

describe("WebSerialTransport", () => {
  it("TODO: open() should request and open a serial port", async () => {
    const transport = new WebSerialTransport();
    // Expected to throw until implemented — this is a failing placeholder.
    await expect(transport.open()).rejects.toThrow("not implemented yet");
  });

  it("TODO: write() should send bytes to the serial port", async () => {
    const transport = new WebSerialTransport();
    await expect(transport.write(new Uint8Array([0x24, 0x4d]))).rejects.toThrow(
      "not implemented yet",
    );
  });

  it("subscribe() registers a handler and unsubscribing removes it", () => {
    const transport = new WebSerialTransport();
    const received: Uint8Array[] = [];
    const unsub = transport.subscribe((data) => received.push(data));
    // Simulate an incoming chunk (internal dispatch — will be replaced by real pump in impl).
    // For now just verify the subscription machinery compiles and runs without error.
    unsub();
    expect(received).toHaveLength(0);
  });
});
