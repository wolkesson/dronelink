/**
 * WebSerialTransport — SerialTransport implementation using the Web Serial API (navigator.serial).
 *
 * Available in desktop Chrome only (not on Android WebView, not on Firefox/Safari).
 * Used during Phases 0–2 while the real flight controller is wired to a PC.
 *
 * TODO (Phase 0 serial spike):
 *   - Call navigator.serial.requestPort() / port.open() with the correct baud rate.
 *   - Pump port.readable into the subscriber callbacks using a ReadableStream reader loop.
 *   - Pipe write() calls through port.writable.
 *   - Handle port disconnect events and surface errors gracefully.
 */
import type { SerialTransport } from "./SerialTransport.js";

export class WebSerialTransport implements SerialTransport {
  private readonly handlers = new Set<(data: Uint8Array) => void>();

  async open(): Promise<void> {
    // TODO: request and open the serial port via navigator.serial.
    throw new Error("WebSerialTransport.open() not implemented yet — see TODO above.");
  }

  async close(): Promise<void> {
    // TODO: close the serial port and release the reader/writer.
    throw new Error("WebSerialTransport.close() not implemented yet — see TODO above.");
  }

  async write(_data: Uint8Array): Promise<void> {
    // TODO: write bytes to port.writable.
    throw new Error("WebSerialTransport.write() not implemented yet — see TODO above.");
  }

  subscribe(handler: (data: Uint8Array) => void): () => void {
    this.handlers.add(handler);
    return () => this.handlers.delete(handler);
  }
}
