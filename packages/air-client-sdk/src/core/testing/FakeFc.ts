/** Test-only: a serial transport wired to a scripted Betaflight that answers MSP requests. */
import { MspCommand, MspParser, encodeMspV1 } from "@dronelink/fc-msp";
import type { SerialTransport } from "../../transport/SerialTransport.js";

export const ascii = (text: string) => [...text].map((char) => char.charCodeAt(0));
export const u16 = (value: number) => [value & 0xff, (value >> 8) & 0xff];
const i16 = (value: number) => u16(value & 0xffff);
const u32 = (value: number) => [...u16(value & 0xffff), ...u16(value >>> 16)];
const i32 = (value: number) => u32(value >>> 0);

/** MSP_STATUS_EX with the given flag bits (bit i = i-th box of BOXIDS [ARM, ALTHOLD, POS HOLD, MSP OVERRIDE]). */
export function statusPayload(flags: number, armingDisableFlags = 0): Uint8Array {
  return new Uint8Array([
    ...u16(125), ...u16(0), ...u16(0x2f), flags, 0, 0, 0, 0, ...u16(12), ...u16(0x0302), 0, 26, ...u32(armingDisableFlags), 0,
  ]);
}

export function identificationReplies(variant = "BTFL"): Record<number, Uint8Array> {
  const build = new Uint8Array(26);
  build.set(ascii("20260601AAA"));
  build.set(ascii("12000000"), 11);
  build.set(ascii("abcdefg"), 19);
  const rescue = new Uint8Array(18);
  rescue.set(u16(1300), 12);
  return {
    [MspCommand.API_VERSION]: new Uint8Array([0, 1, 48]),
    [MspCommand.FC_VARIANT]: new Uint8Array(ascii(variant)),
    [MspCommand.FC_VERSION]: new Uint8Array([26, 6, 2, 8, ...ascii("2026.6.2")]),
    [MspCommand.BOARD_INFO]: new Uint8Array([...ascii("S7X2"), ...u16(1), 2, 1, 4, ...ascii("STM7"), 5, ...ascii("Board"), 3, ...ascii("ACM")]),
    [MspCommand.BUILD_INFO]: build,
    [MspCommand.BOXNAMES]: new Uint8Array(ascii("ARM;ALTHOLD;POS HOLD;MSP OVERRIDE;")),
    [MspCommand.BOXIDS]: new Uint8Array([0, 3, 11, 50]),
    [MspCommand.RX_MAP]: new Uint8Array([1, 0, 3, 2]),
    [MspCommand.GPS_RESCUE]: rescue,
  };
}

export function telemetryReplies(): Record<number, Uint8Array> {
  return {
    [MspCommand.STATUS_EX]: statusPayload(0b1111),
    [MspCommand.RC]: new Uint8Array([...u16(1500), ...u16(1501), ...u16(1502), ...u16(1300), ...u16(1900)]),
    [MspCommand.ATTITUDE]: new Uint8Array([...i16(-15), ...i16(25), ...i16(270)]),
    [MspCommand.ALTITUDE]: new Uint8Array([...i32(1234), ...i16(-50)]),
    [MspCommand.RAW_GPS]: new Uint8Array([2, 12, ...i32(593293000), ...i32(180686000), ...u16(40), ...u16(120), ...u16(900), ...u16(150)]),
    [MspCommand.COMP_GPS]: new Uint8Array([...u16(42), ...i16(-90), 1]),
    [MspCommand.ANALOG]: new Uint8Array([168, ...u16(321), ...u16(1023), ...i16(1250), ...u16(1680)]),
    [MspCommand.SET_RAW_RC]: new Uint8Array(0),
  };
}

/** A serial transport wired to a scripted FC that answers MSP requests. */
export class FakeFc implements SerialTransport {
  readonly writes: Uint8Array[] = [];
  readonly requests: number[] = [];
  replies: Record<number, Uint8Array | "error"> = { ...identificationReplies(), ...telemetryReplies() };
  responding = true;
  private handler: ((data: Uint8Array) => void) | null = null;
  private readonly parser = new MspParser();

  async open(): Promise<void> {}
  async close(): Promise<void> {}

  subscribe(handler: (data: Uint8Array) => void): () => void {
    this.handler = handler;
    return () => {
      this.handler = null;
    };
  }

  async write(data: Uint8Array): Promise<void> {
    this.writes.push(data);
    for (const frame of this.parser.push(data)) {
      if (frame.direction !== "request") continue;
      this.requests.push(frame.command);
      if (frame.command === MspCommand.SET_RAW_RC) this.applyOverride(frame.payload);
      const reply = this.replies[frame.command];
      if (!this.responding || reply === undefined) continue;
      const bytes = reply === "error" ? encodeMspV1("error", frame.command) : encodeMspV1("response", frame.command, reply);
      queueMicrotask(() => this.emit(bytes));
    }
  }

  /**
   * With `echoOverride`, behaves like Betaflight's MSP override with the stick mask: MSP_RC
   * (internal order R, P, Y, T, AUX1) reports the overridden sticks via the RX map [1, 0, 3, 2].
   */
  echoOverride = false;
  readonly rcFrames: number[][] = [];

  private applyOverride(payload: Uint8Array): void {
    const raw: number[] = [];
    for (let i = 0; i + 1 < payload.length; i += 2) raw.push(payload[i] | (payload[i + 1] << 8));
    this.rcFrames.push(raw);
    if (!this.echoOverride) return;
    const rxMap = [1, 0, 3, 2];
    const sticks = rxMap.map((rawChannel) => raw[rawChannel]);
    this.replies[MspCommand.RC] = new Uint8Array([...sticks, 1900].flatMap(u16));
  }

  emit(bytes: Uint8Array): void {
    this.handler?.(bytes);
  }

  get subscribed(): boolean {
    return this.handler !== null;
  }

  count(command: number): number {
    return this.requests.filter((requested) => requested === command).length;
  }
}

