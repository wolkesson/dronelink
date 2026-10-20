/**
 * WebSocketSerialTransport — dev-only SerialTransport that reaches a serial port through a
 * WebSocket↔TCP bridge (tools/sitl-serial-bridge.mjs), so the air webapp can talk to a
 * Betaflight SITL build — whose UARTs are TCP sockets — instead of a USB flight controller.
 *
 * Bytes are relayed opaquely, as binary WebSocket messages, exactly like the other transports.
 * A bridge-side close is reported to subscribers as a zero-length chunk, the same disconnect
 * signal WebSerialTransport and NativeBridgeTransport use.
 */
import type { SerialTransport } from "./SerialTransport.js";

type WebSocketConstructor = new (url: string) => WebSocket;

// WebSocket.OPEN, spelled out so an injected test double needn't define the static constants.
const WEBSOCKET_OPEN = 1;

export class WebSocketSerialTransport implements SerialTransport {
  private readonly handlers = new Set<(data: Uint8Array) => void>();
  private socket: WebSocket | null = null;

  constructor(
    private readonly url: string,
    private readonly WebSocketCtor: WebSocketConstructor = WebSocket,
  ) {}

  open(): Promise<void> {
    if (this.socket) {
      return Promise.reject(new Error("WebSocket serial transport is already open."));
    }
    const socket = new this.WebSocketCtor(this.url);
    socket.binaryType = "arraybuffer";
    this.socket = socket;

    return new Promise<void>((resolve, reject) => {
      let opened = false;
      socket.onopen = () => {
        opened = true;
        resolve();
      };
      socket.onmessage = (event: MessageEvent) => {
        if (event.data instanceof ArrayBuffer && event.data.byteLength > 0) {
          this.dispatch(new Uint8Array(event.data));
        }
      };
      socket.onclose = () => {
        // close() detaches the socket first, so a socket that is still current closed on
        // its own: the bridge or SITL went away.
        const unexpected = this.socket === socket;
        if (unexpected) {
          this.socket = null;
        }
        if (!opened) {
          reject(new Error(`Could not connect to serial bridge at ${this.url}.`));
        } else if (unexpected) {
          this.dispatch(new Uint8Array(0));
        }
      };
    });
  }

  async close(): Promise<void> {
    const socket = this.socket;
    if (!socket) return;
    this.socket = null;
    socket.close();
  }

  async write(data: Uint8Array): Promise<void> {
    if (!this.socket || this.socket.readyState !== WEBSOCKET_OPEN) {
      throw new Error("Serial bridge is not connected.");
    }
    this.socket.send(data);
  }

  subscribe(handler: (data: Uint8Array) => void): () => void {
    this.handlers.add(handler);
    return () => this.handlers.delete(handler);
  }

  private dispatch(data: Uint8Array): void {
    for (const handler of this.handlers) {
      handler(data);
    }
  }
}
