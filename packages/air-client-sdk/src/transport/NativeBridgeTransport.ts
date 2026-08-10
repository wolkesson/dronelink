/**
 * NativeBridgeTransport — SerialTransport implementation for the Android native shell.
 *
 * The Android shell owns the USB device and reads/writes the serial connection directly.
 * It exposes the byte stream to the WebView as a MessagePort, handed off via a window
 * "message" event carrying NATIVE_BRIDGE_PORT_MESSAGE alongside the port (see
 * android-shell's NativeSerialBridgeController.kt for the native side of this handoff).
 *
 * This class deliberately never touches `window` itself — receivePort() is the only way
 * a port reaches it, called by app-layer bootstrap code that owns the window listener.
 * That keeps this class runnable under plain Node (no DOM) for testing, and keeps the
 * "are we running inside android-shell, and where do window messages get wired up"
 * decision in the app layer, where platform composition belongs.
 */
import type { SerialTransport } from "./SerialTransport.js";

/**
 * Window-message payload the Android native shell posts, alongside a transferred
 * MessagePort, once its USB serial bridge is ready to exchange bytes.
 */
export const NATIVE_BRIDGE_PORT_MESSAGE = "dronelink:native-bridge-port";

export class NativeBridgeTransport implements SerialTransport {
  private readonly handlers = new Set<(data: Uint8Array) => void>();
  private port: MessagePort | null = null;
  private portReadyPromise: Promise<MessagePort> | null = null;
  private resolvePortReady: ((port: MessagePort) => void) | null = null;

  /**
   * Hands the transport the MessagePort received from the native shell. Safe to call
   * before or after open() — whichever happens first, the other picks up the port.
   */
  receivePort(port: MessagePort): void {
    this.port = port;
    this.resolvePortReady?.(port);
  }

  /** Waits for the native shell's MessagePort (already-received or not) and starts it. */
  async open(): Promise<void> {
    const port = this.port ?? (await this.awaitPort());
    this.port = port;
    port.onmessage = this.handlePortMessage;
    port.start?.();
  }

  async close(): Promise<void> {
    if (this.port) {
      this.port.onmessage = null;
      this.port.close?.();
    }
    this.port = null;
    this.portReadyPromise = null;
    this.resolvePortReady = null;
  }

  /**
   * Sends exactly the bytes in `data` (not its whole underlying buffer, which may be
   * larger than the view) as a structured-clone copy — not transferred, so the caller's
   * array remains valid after this call, matching WebSerialTransport's semantics.
   */
  async write(data: Uint8Array): Promise<void> {
    if (!this.port) {
      throw new Error("NativeBridgeTransport is not open.");
    }
    const buffer = data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength);
    this.port.postMessage(buffer);
  }

  subscribe(handler: (data: Uint8Array) => void): () => void {
    this.handlers.add(handler);
    return () => this.handlers.delete(handler);
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  private awaitPort(): Promise<MessagePort> {
    if (!this.portReadyPromise) {
      this.portReadyPromise = new Promise((resolve) => {
        this.resolvePortReady = resolve;
      });
    }
    return this.portReadyPromise;
  }

  private handlePortMessage = (event: MessageEvent<ArrayBuffer>): void => {
    this.dispatch(new Uint8Array(event.data));
  };

  private dispatch(data: Uint8Array): void {
    for (const handler of this.handlers) {
      handler(data);
    }
  }
}
