/**
 * WebSerialTransport — SerialTransport implementation using the Web Serial API (navigator.serial).
 *
 * Available in desktop Chrome only (not on Android WebView, not on Firefox/Safari).
 * Used during Phases 0–2 while the real flight controller is wired to a PC.
 *
 * IMPORTANT: open() must be called synchronously inside a user-gesture handler (e.g. a button
 * click). Calling it on page load or in an async chain that has already yielded will throw a
 * SecurityError because requestPort() requires a transient user activation (the browser's
 * time-limited permission granted by a direct user interaction such as a button click).
 */
import type { SerialTransport } from "./SerialTransport.js";

/** Baud rate used by INAV's default MSP configuration. */
const BAUD_RATE = 115200;

export class WebSerialTransport implements SerialTransport {
  private readonly handlers = new Set<(data: Uint8Array) => void>();
  private port: SerialPort | null = null;
  private reader: ReadableStreamDefaultReader<Uint8Array> | null = null;
  private writer: WritableStreamDefaultWriter<Uint8Array> | null = null;
  private readLoopPromise: Promise<void> | null = null;

  /**
   * Request a serial port from the user and open it at 115200 baud.
   *
   * Must be called synchronously from a user-gesture handler; requestPort() will throw a
   * SecurityError if the gesture context has been lost.
   *
   * Throws if navigator.serial is unavailable (wrong browser / non-secure context), or if
   * the user dismisses the port-picker dialog.
   */
  async open(): Promise<void> {
    if (!("serial" in navigator) || !navigator.serial) {
      throw new Error(
        "Web Serial API is not available. " +
          "Use desktop Chrome (or Edge) and ensure the page is served over HTTPS or localhost.",
      );
    }

    // requestPort() must be called synchronously inside the user-gesture handler.
    // No vendor/product filters — intentional: we don't know the USB-serial chipset yet.
    this.port = await navigator.serial.requestPort();
    await this.port.open({ baudRate: BAUD_RATE });

    // Acquire the writer once and keep it for the session. Re-acquiring per write() call is
    // not allowed while the stream is locked to an existing writer.
    if (this.port.writable) {
      this.writer = this.port.writable.getWriter();
    }

    // Start the read loop in the background; do not await it here.
    this.readLoopPromise = this.readLoop();
  }

  /**
   * Release the writer and reader locks, then close the port.
   * Safe to call even if the port is already closed or was never opened.
   */
  async close(): Promise<void> {
    if (this.reader) {
      try {
        // cancel() causes the next read() call in the loop to resolve with done:true,
        // so the loop exits cleanly. releaseLock() is handled by the loop's finally block.
        await this.reader.cancel();
      } catch {
        // Ignore errors from cancelling an already-errored reader.
      }
      this.reader = null;
    }

    // Wait for the read loop to finish before closing the port, so the readable stream
    // is no longer locked when we call port.close().
    if (this.readLoopPromise) {
      await this.readLoopPromise.catch(() => undefined);
      this.readLoopPromise = null;
    }

    // Release the writer so the writable stream is no longer locked before port.close().
    if (this.writer) {
      try {
        this.writer.releaseLock();
      } catch {
        // Already released or port already closed.
      }
      this.writer = null;
    }

    if (this.port) {
      try {
        await this.port.close();
      } catch {
        // Ignore errors if the port was already closed (e.g. device unplugged).
      }
      this.port = null;
    }
  }

  /**
   * Write raw bytes to the serial port using the persistent writer acquired at open().
   * Throws if the port was not opened first.
   */
  async write(data: Uint8Array): Promise<void> {
    if (!this.writer) {
      throw new Error("Serial port is not open.");
    }
    await this.writer.write(data);
  }

  subscribe(handler: (data: Uint8Array) => void): () => void {
    this.handlers.add(handler);
    return () => this.handlers.delete(handler);
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  private async readLoop(): Promise<void> {
    if (!this.port?.readable) {
      return;
    }

    this.reader = this.port.readable.getReader();
    try {
      for (;;) {
        const { value, done } = await this.reader.read();
        if (done) {
          break;
        }
        if (value) {
          this.dispatch(value);
        }
      }
    } catch (err) {
      // A NetworkError means the device was physically disconnected mid-read.
      // Surface it to subscribers as a special zero-length chunk tagged with an error
      // property, then let the loop exit naturally.
      if (err instanceof DOMException && err.name === "NetworkError") {
        // Notify the UI layer so it can update its status display.
        this.dispatchDisconnect();
      }
      // Any other error (e.g. the reader was cancelled by close()) is silently swallowed
      // — close() is the normal teardown path and does not represent an error.
    } finally {
      if (this.reader) {
        try {
          this.reader.releaseLock();
        } catch {
          // Already released.
        }
        this.reader = null;
      }
    }
  }

  private dispatch(data: Uint8Array): void {
    for (const handler of this.handlers) {
      handler(data);
    }
  }

  /**
   * Fires a synthetic zero-length chunk so the UI can detect device disconnection
   * without needing to know about DOMException internals.
   */
  private dispatchDisconnect(): void {
    this.dispatch(new Uint8Array(0));
  }
}
