/**
 * Placeholder tests for NativeBridgeTransport.
 *
 * These tests are intentionally failing until the implementation is complete (Phase 2.5).
 *
 * TODO (Phase 2.5):
 *   - Provide a fake MessagePort to the transport instead of waiting for the native shell.
 *   - Assert that open() awaits and stores the port.
 *   - Assert that write() posts an ArrayBuffer message on the port.
 *   - Assert that incoming port messages are dispatched to subscribe() handlers.
 *   - Assert that close() posts a "close" signal and clears the port reference.
 *   - Do NOT add any Android/USB/native code here — the native side lives in /android-shell.
 */
import { describe, it, expect } from "vitest";
import { NativeBridgeTransport } from "./NativeBridgeTransport.js";

describe("NativeBridgeTransport", () => {
  it("TODO: open() should wait for the MessagePort from the native shell", async () => {
    const transport = new NativeBridgeTransport();
    // Expected to throw until implemented — this is a failing placeholder.
    await expect(transport.open()).rejects.toThrow("not implemented yet");
  });

  it("TODO: write() should post bytes to the native shell via the MessagePort", async () => {
    const transport = new NativeBridgeTransport();
    await expect(transport.write(new Uint8Array([0x01, 0x02]))).rejects.toThrow(
      "not implemented yet",
    );
  });

  it("subscribe() registers a handler and unsubscribing removes it", () => {
    const transport = new NativeBridgeTransport();
    const received: Uint8Array[] = [];
    const unsub = transport.subscribe((data) => received.push(data));
    unsub();
    expect(received).toHaveLength(0);
  });
});
