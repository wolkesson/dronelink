import { MspParser, encodeMspRequest } from "@dronelink/fc-msp";

interface PendingRequest {
  command: number;
  resolve: (payload: Uint8Array | null) => void;
  timer: ReturnType<typeof setTimeout>;
  forward: (bytes: Uint8Array) => void;
}

function frameLength(bytes: Uint8Array): number | null | undefined {
  if (bytes.length < 3) return null;
  if (bytes[0] !== 0x24 || (bytes[1] !== 0x4d && bytes[1] !== 0x58)) return undefined;
  if (bytes[1] === 0x4d) {
    if (![0x3c, 0x3e, 0x21].includes(bytes[2]!)) return undefined;
    if (bytes.length < 5) return null;
    if (bytes[3] === 0xff) {
      if (bytes.length < 7) return null;
      return 8 + bytes[5]! + (bytes[6]! << 8);
    }
    return 6 + bytes[3]!;
  }
  if (![0x3c, 0x3e, 0x21].includes(bytes[2]!)) return undefined;
  if (bytes.length < 8) return null;
  return 9 + bytes[6]! + (bytes[7]! << 8);
}

/**
 * Serializes active MSP queries and consumes only their matching response frames.
 * Incomplete candidate bytes are held only during a probe and flushed on timeout.
 */
export class MspProbeBroker {
  private pending: PendingRequest | null = null;
  private buffered = new Uint8Array(0);

  constructor(
    private readonly write: (bytes: Uint8Array) => Promise<void>,
    private readonly timeoutMs = 1_500,
  ) {}

  get hasPendingRequest(): boolean {
    return this.pending !== null;
  }

  request(command: number, forward: (bytes: Uint8Array) => void): Promise<Uint8Array | null> {
    if (this.pending) return Promise.reject(new Error("An MSP query is already pending."));
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => this.finish(null, true), this.timeoutMs);
      this.pending = { command, resolve, timer, forward };
      void this.write(encodeMspRequest(command)).catch((error: unknown) => {
        if (!this.pending) return;
        clearTimeout(timer);
        this.pending = null;
        this.flushBuffered(forward);
        reject(error);
      });
    });
  }

  /** Returns bytes safe to forward; a matched probe response is excluded. */
  receive(bytes: Uint8Array): Uint8Array {
    if (!this.pending) return bytes;
    const combined = new Uint8Array(this.buffered.length + bytes.length);
    combined.set(this.buffered);
    combined.set(bytes, this.buffered.length);
    this.buffered = new Uint8Array(0);
    const forwarded: Uint8Array[] = [];
    let forwardedLength = 0;
    const append = (part: Uint8Array) => {
      if (part.length === 0) return;
      forwarded.push(part);
      forwardedLength += part.length;
    };
    let offset = 0;

    while (offset < combined.length) {
      const start = combined.indexOf(0x24, offset);
      if (start < 0) {
        append(combined.subarray(offset));
        break;
      }
      append(combined.subarray(offset, start));
      const available = combined.subarray(start);
      const length = frameLength(available);
      if (length === null) {
        this.buffered = available.slice();
        break;
      }
      if (length === undefined) {
        append(combined.subarray(start, start + 1));
        offset = start + 1;
        continue;
      }
      if (available.length < length) {
        this.buffered = available.slice();
        break;
      }

      const raw = available.slice(0, length);
      const parser = new MspParser({ maxPayloadSize: 65_535 });
      const [frame] = parser.push(raw);
      if (frame && frame.command === this.pending?.command && frame.direction !== "request") {
        this.finish(frame.payload, false);
      } else {
        append(raw);
      }
      offset = start + length;
      if (!this.pending && offset < combined.length) {
        append(combined.subarray(offset));
        break;
      }
    }
    const output = new Uint8Array(forwardedLength);
    let outputOffset = 0;
    for (const part of forwarded) {
      output.set(part, outputOffset);
      outputOffset += part.length;
    }
    return output;
  }

  cancel(): void {
    if (this.pending) this.finish(null, true);
  }

  private finish(payload: Uint8Array | null, flush: boolean): void {
    const pending = this.pending;
    if (!pending) return;
    clearTimeout(pending.timer);
    this.pending = null;
    if (flush) this.flushBuffered(pending.forward);
    else this.buffered = new Uint8Array(0);
    pending.resolve(payload);
  }

  private flushBuffered(forward: (bytes: Uint8Array) => void): void {
    if (this.buffered.length > 0) forward(this.buffered);
    this.buffered = new Uint8Array(0);
  }
}
