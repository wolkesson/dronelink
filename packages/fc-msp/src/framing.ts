/**
 * MSP v1 and v2 framing: encoders and a streaming parser.
 *
 * Wire formats (Betaflight msp_serial.c):
 *   v1:          '$' 'M' dir  size:u8  cmd:u8  payload  xor(size..payload)
 *   v1 jumbo:    '$' 'M' dir  0xFF     cmd:u8  size:u16 payload  xor(0xFF..payload)
 *   v2:          '$' 'X' dir  flags:u8 cmd:u16 size:u16 payload  crc8_dvb_s2(flags..payload)
 *   v2 over v1:  a v1 frame with cmd 0xFF whose payload is a v2 header + payload + crc8
 * dir is '<' for a request, '>' for a response and '!' for an error response.
 */

export type MspVersion = 1 | 2;
export type MspDirection = "request" | "response" | "error";

export interface MspFrame {
  version: MspVersion;
  direction: MspDirection;
  command: number;
  /** v2 flags byte; always 0 for v1 frames. */
  flags: number;
  payload: Uint8Array;
}

export interface MspParserStats {
  frames: number;
  checksumErrors: number;
  oversizeFrames: number;
  discardedBytes: number;
}

export interface MspParserOptions {
  /**
   * Frames announcing a larger payload are treated as garbage. A corrupt header below the
   * limit holds back the frames behind it until that many bytes have arrived (they are then
   * recovered, not lost), so keep it close to the largest reply actually expected.
   * Default 1024: Betaflight's MSP output buffer is 512 bytes without dataflash support.
   */
  maxPayloadSize?: number;
}

const PREAMBLE = 0x24; // '$'
const V1_MARKER = 0x4d; // 'M'
const V2_MARKER = 0x58; // 'X'
const JUMBO_SIZE = 0xff;
const V2_OVER_V1_COMMAND = 0xff;
const V1_HEADER_LENGTH = 5;
const V1_JUMBO_HEADER_LENGTH = 7;
const V2_HEADER_LENGTH = 8;
const V2_INNER_HEADER_LENGTH = 5;
const DEFAULT_MAX_PAYLOAD_SIZE = 1024;

const DIRECTION_BYTES: Record<MspDirection, number> = { request: 0x3c, response: 0x3e, error: 0x21 };

function directionFromByte(byte: number): MspDirection | null {
  switch (byte) {
    case 0x3c:
      return "request";
    case 0x3e:
      return "response";
    case 0x21:
      return "error";
    default:
      return null;
  }
}

export function crc8DvbS2(data: Uint8Array, initial = 0): number {
  let crc = initial;
  for (const byte of data) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) {
      crc = crc & 0x80 ? ((crc << 1) ^ 0xd5) & 0xff : (crc << 1) & 0xff;
    }
  }
  return crc;
}

function xorChecksum(data: Uint8Array): number {
  let checksum = 0;
  for (const byte of data) checksum ^= byte;
  return checksum;
}

function assertByteRange(name: string, value: number, max: number): void {
  if (!Number.isInteger(value) || value < 0 || value > max) {
    throw new RangeError(`${name} must be an integer in 0..${max}, got ${value}`);
  }
}

/** Encodes a v1 frame, switching to a jumbo frame for payloads of 255 bytes or more. */
export function encodeMspV1(direction: MspDirection, command: number, payload: Uint8Array = new Uint8Array(0)): Uint8Array {
  assertByteRange("MSP v1 command", command, 0xff);
  assertByteRange("MSP v1 payload length", payload.length, 0xffff);
  const jumbo = payload.length >= JUMBO_SIZE;
  const headerLength = jumbo ? V1_JUMBO_HEADER_LENGTH : V1_HEADER_LENGTH;
  const frame = new Uint8Array(headerLength + payload.length + 1);
  frame.set([PREAMBLE, V1_MARKER, DIRECTION_BYTES[direction]]);
  if (jumbo) {
    frame.set([JUMBO_SIZE, command, payload.length & 0xff, payload.length >> 8], 3);
  } else {
    frame.set([payload.length, command], 3);
  }
  frame.set(payload, headerLength);
  frame[frame.length - 1] = xorChecksum(frame.subarray(3, frame.length - 1));
  return frame;
}

export function encodeMspV2(
  direction: MspDirection,
  command: number,
  payload: Uint8Array = new Uint8Array(0),
  flags = 0,
): Uint8Array {
  assertByteRange("MSP v2 command", command, 0xffff);
  assertByteRange("MSP v2 flags", flags, 0xff);
  assertByteRange("MSP v2 payload length", payload.length, 0xffff);
  const frame = new Uint8Array(V2_HEADER_LENGTH + payload.length + 1);
  frame.set([PREAMBLE, V2_MARKER, DIRECTION_BYTES[direction], flags]);
  frame.set([command & 0xff, command >> 8, payload.length & 0xff, payload.length >> 8], 4);
  frame.set(payload, V2_HEADER_LENGTH);
  frame[frame.length - 1] = crc8DvbS2(frame.subarray(3, frame.length - 1));
  return frame;
}

/** Encodes a request, as v1 unless the command only exists in v2 (above 255). */
export function encodeMspRequest(command: number, payload?: Uint8Array, version: MspVersion = command > 0xff ? 2 : 1): Uint8Array {
  return version === 1 ? encodeMspV1("request", command, payload) : encodeMspV2("request", command, payload);
}

type ParseOutcome =
  | { kind: "frame"; frame: MspFrame | null; length: number }
  | { kind: "incomplete" }
  | { kind: "invalid"; reason: "checksum" | "oversize" | "header" };

/**
 * Streaming MSP parser. Feed it arbitrary chunks of a byte stream; it returns every complete,
 * checksum-valid frame and skips anything else (noise, truncated or corrupt frames, other
 * protocols), resynchronising on the next '$'. It never throws on input.
 */
export class MspParser {
  private buffer = new Uint8Array(0);
  private readonly maxPayloadSize: number;
  private readonly counters: MspParserStats = { frames: 0, checksumErrors: 0, oversizeFrames: 0, discardedBytes: 0 };

  constructor(options: MspParserOptions = {}) {
    this.maxPayloadSize = options.maxPayloadSize ?? DEFAULT_MAX_PAYLOAD_SIZE;
  }

  get stats(): Readonly<MspParserStats> {
    return { ...this.counters };
  }

  /** Bytes held while waiting for the rest of a frame. */
  get pendingBytes(): number {
    return this.buffer.length;
  }

  reset(): void {
    this.buffer = new Uint8Array(0);
  }

  push(chunk: Uint8Array): MspFrame[] {
    if (chunk.length > 0) {
      const merged = new Uint8Array(this.buffer.length + chunk.length);
      merged.set(this.buffer);
      merged.set(chunk, this.buffer.length);
      this.buffer = merged;
    }

    const frames: MspFrame[] = [];
    let offset = 0;
    while (offset < this.buffer.length) {
      const start = this.buffer.indexOf(PREAMBLE, offset);
      if (start < 0) {
        this.counters.discardedBytes += this.buffer.length - offset;
        offset = this.buffer.length;
        break;
      }
      this.counters.discardedBytes += start - offset;
      offset = start;

      const outcome = this.parseAt(start);
      if (outcome.kind === "incomplete") break;
      if (outcome.kind === "invalid") {
        if (outcome.reason === "checksum") this.counters.checksumErrors++;
        if (outcome.reason === "oversize") this.counters.oversizeFrames++;
        // Drop only the '$': a real frame may start inside what looked like this one.
        this.counters.discardedBytes++;
        offset = start + 1;
        continue;
      }
      if (outcome.frame) {
        this.counters.frames++;
        frames.push(outcome.frame);
      } else {
        this.counters.checksumErrors++;
        this.counters.discardedBytes += outcome.length;
      }
      offset = start + outcome.length;
    }

    this.buffer = this.buffer.slice(offset);
    return frames;
  }

  private parseAt(start: number): ParseOutcome {
    const buf = this.buffer;
    if (buf.length < start + 3) return { kind: "incomplete" };
    const marker = buf[start + 1];
    const direction = directionFromByte(buf[start + 2]);
    if ((marker !== V1_MARKER && marker !== V2_MARKER) || direction === null) {
      return { kind: "invalid", reason: "header" };
    }
    return marker === V1_MARKER ? this.parseV1(start, direction) : this.parseV2(start, direction);
  }

  private parseV1(start: number, direction: MspDirection): ParseOutcome {
    const buf = this.buffer;
    if (buf.length < start + V1_HEADER_LENGTH) return { kind: "incomplete" };
    let size = buf[start + 3];
    const command = buf[start + 4];
    let headerLength = V1_HEADER_LENGTH;
    if (size === JUMBO_SIZE) {
      if (buf.length < start + V1_JUMBO_HEADER_LENGTH) return { kind: "incomplete" };
      size = buf[start + 5] | (buf[start + 6] << 8);
      headerLength = V1_JUMBO_HEADER_LENGTH;
    }
    if (size > this.maxPayloadSize) return { kind: "invalid", reason: "oversize" };
    const length = headerLength + size + 1;
    if (buf.length < start + length) return { kind: "incomplete" };
    if (xorChecksum(buf.subarray(start + 3, start + length - 1)) !== buf[start + length - 1]) {
      return { kind: "invalid", reason: "checksum" };
    }
    const payload = buf.slice(start + headerLength, start + headerLength + size);
    if (command === V2_OVER_V1_COMMAND) {
      return { kind: "frame", frame: decodeV2OverV1(direction, payload), length };
    }
    return { kind: "frame", frame: { version: 1, direction, command, flags: 0, payload }, length };
  }

  private parseV2(start: number, direction: MspDirection): ParseOutcome {
    const buf = this.buffer;
    if (buf.length < start + V2_HEADER_LENGTH) return { kind: "incomplete" };
    const size = buf[start + 6] | (buf[start + 7] << 8);
    if (size > this.maxPayloadSize) return { kind: "invalid", reason: "oversize" };
    const length = V2_HEADER_LENGTH + size + 1;
    if (buf.length < start + length) return { kind: "incomplete" };
    if (crc8DvbS2(buf.subarray(start + 3, start + length - 1)) !== buf[start + length - 1]) {
      return { kind: "invalid", reason: "checksum" };
    }
    return {
      kind: "frame",
      frame: {
        version: 2,
        direction,
        command: buf[start + 4] | (buf[start + 5] << 8),
        flags: buf[start + 3],
        payload: buf.slice(start + V2_HEADER_LENGTH, start + length - 1),
      },
      length,
    };
  }
}

/** Unwraps a v2 frame tunnelled in a v1 frame; null when the inner frame is malformed. */
function decodeV2OverV1(direction: MspDirection, inner: Uint8Array): MspFrame | null {
  if (inner.length < V2_INNER_HEADER_LENGTH + 1) return null;
  const size = inner[3] | (inner[4] << 8);
  if (inner.length !== V2_INNER_HEADER_LENGTH + size + 1) return null;
  if (crc8DvbS2(inner.subarray(0, inner.length - 1)) !== inner[inner.length - 1]) return null;
  return {
    version: 2,
    direction,
    command: inner[1] | (inner[2] << 8),
    flags: inner[0],
    payload: inner.slice(V2_INNER_HEADER_LENGTH, V2_INNER_HEADER_LENGTH + size),
  };
}
