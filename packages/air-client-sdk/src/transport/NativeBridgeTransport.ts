/**
 * NativeBridgeTransport — SerialTransport implementation for the Android native shell.
 *
 * The Android shell owns the USB device and reads/writes the serial connection directly.
 * It exposes the byte stream to the WebView via a WebMessageChannel, so the PWA can
 * participate in serial I/O without any native Android code in this module.
 *
 * This transport is used from Phase 2.5 onward (when /android-shell is built).
 *
 * TODO (Phase 2.5):
 *   - Receive the MessagePort from the native shell (injected via addJavascriptInterface or
 *     a window.onmessage bootstrap message).
 *   - Post outgoing bytes as ArrayBuffer messages on the port.
 *   - Subscribe to incoming ArrayBuffer messages from the port and dispatch them to handlers.
 *   - Do NOT implement any USB or Android-specific logic here — that lives entirely in
 *     /android-shell (Kotlin).
 */
import type { SerialTransport } from "./SerialTransport.js";

export class NativeBridgeTransport implements SerialTransport {
  private readonly handlers = new Set<(data: Uint8Array) => void>();

  async open(): Promise<void> {
    // TODO: wait for the MessagePort from the native shell.
    throw new Error("NativeBridgeTransport.open() not implemented yet — see TODO above.");
  }

  async close(): Promise<void> {
    // TODO: signal the native shell to release the serial port and close the MessagePort.
    throw new Error("NativeBridgeTransport.close() not implemented yet — see TODO above.");
  }

  async write(_data: Uint8Array): Promise<void> {
    // TODO: post bytes to the native shell via the MessagePort.
    throw new Error("NativeBridgeTransport.write() not implemented yet — see TODO above.");
  }

  subscribe(handler: (data: Uint8Array) => void): () => void {
    this.handlers.add(handler);
    return () => this.handlers.delete(handler);
  }
}
