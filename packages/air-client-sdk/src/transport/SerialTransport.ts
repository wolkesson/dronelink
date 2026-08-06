/**
 * SerialTransport — transport-agnostic interface for reading and writing raw serial bytes.
 *
 * Implementations:
 *   - WebSerialTransport   — uses navigator.serial (desktop Chrome, Phases 0–2)
 *   - NativeBridgeTransport — receives bytes from the Android native shell via WebMessageChannel
 *                             (Phase 2.5+)
 *
 * Nothing above this interface knows or cares about the serial protocol (MSP, MAVLink, etc.).
 * All bytes are forwarded opaquely.
 */
export interface SerialTransport {
  /** Write raw bytes to the serial device. */
  write(data: Uint8Array): Promise<void>;

  /**
   * Subscribe to incoming bytes from the serial device.
   * Returns an unsubscribe function.
   */
  subscribe(handler: (data: Uint8Array) => void): () => void;

  /** Open / connect the transport. Must be called before write/subscribe are useful. */
  open(): Promise<void>;

  /** Close / disconnect the transport. */
  close(): Promise<void>;
}
