import { MspParser } from "@dronelink/fc-msp";
import type { DetectedLinkType } from "@dronelink/core-transport";

const MAVLINK_V1_MAGIC = 0xfe;
const MAVLINK_V2_MAGIC = 0xfd;
const CRSF_ADDRESSES = new Set([0xc8, 0xc9, 0xea, 0xec, 0xee]);

function crc8DvbS2(data: Uint8Array): number {
  let crc = 0;
  for (const byte of data) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) {
      crc = crc & 0x80 ? ((crc << 1) ^ 0xd5) & 0xff : (crc << 1) & 0xff;
    }
  }
  return crc;
}

function mavlinkType(data: Uint8Array): DetectedLinkType | null {
  for (let i = 0; i < data.length; i++) {
    const magic = data[i];
    if (magic === MAVLINK_V1_MAGIC && i + 6 <= data.length) {
      const frameLength = 8 + data[i + 1]!;
      if (i + frameLength <= data.length) return "mavlink-v1";
    }
    if (magic === MAVLINK_V2_MAGIC && i + 10 <= data.length) {
      const frameLength = 12 + data[i + 1]! + ((data[i + 2]! & 1) !== 0 ? 13 : 0);
      if (i + frameLength <= data.length) return "mavlink-v2";
    }
  }
  return null;
}

function crsfType(data: Uint8Array): DetectedLinkType | null {
  for (let i = 0; i + 4 <= data.length; i++) {
    const length = data[i + 1]!;
    const end = i + length + 2;
    if (!CRSF_ADDRESSES.has(data[i]!) || length < 2 || end > data.length) continue;
    if (crc8DvbS2(data.subarray(i + 2, end - 1)) === data[end - 1]) return "crsf";
  }
  return null;
}

/**
 * Read-only serial tap. It never changes, retains, or delays the bytes passed to push().
 * `silent` is reported only after the caller's observation window expires.
 */
export class LinkTypeClassifier {
  private readonly msp = new MspParser();
  private detected: DetectedLinkType = "unknown";
  private sawBytes = false;
  private lastByteAt: number | null = null;
  private buffer = new Uint8Array(0);
  private observingSince = 0;

  constructor(private readonly silenceTimeoutMs = 2_000) {}

  get detectedType(): DetectedLinkType {
    return this.detected;
  }

  push(bytes: Uint8Array, now = Date.now()): DetectedLinkType {
    if (bytes.length === 0) return this.detected;
    if (this.detected === "silent") this.detected = "unknown";
    this.sawBytes = true;
    this.lastByteAt = now;
    const combined = new Uint8Array(this.buffer.length + bytes.length);
    combined.set(this.buffer);
    combined.set(bytes, this.buffer.length);

    const mspFrames = this.msp.push(bytes);
    const msp = mspFrames.find((frame) => frame.direction !== "request");
    if (msp) {
      this.detected = msp.version === 1 ? "msp-v1" : "msp-v2";
      return this.detected;
    }

    const mavlink = mavlinkType(combined);
    if (mavlink) {
      this.detected = mavlink;
      return this.detected;
    }

    const crsf = crsfType(combined);
    if (crsf) this.detected = crsf;
    this.buffer = combined.slice(-280);
    return this.detected;
  }

  tick(now = Date.now()): DetectedLinkType {
    if (this.lastByteAt === null) {
      if (now - this.observingSince >= this.silenceTimeoutMs) this.detected = "silent";
    } else if (now - this.lastByteAt >= this.silenceTimeoutMs) {
      this.detected = "silent";
    }
    return this.detected;
  }

  /** Starts a fresh observation window at `now`, e.g. when the FC link opens. */
  begin(now: number): void {
    this.reset();
    this.observingSince = now;
  }

  reset(): void {
    this.msp.reset();
    this.detected = "unknown";
    this.sawBytes = false;
    this.lastByteAt = null;
    this.buffer = new Uint8Array(0);
  }
}
