import { describe, it, expect } from "vitest";
import {
  BoxId,
  MAX_RC_CHANNELS,
  MspDecodeError,
  activeBoxIds,
  decodeAnalog,
  decodeApiVersion,
  decodeBoardInfo,
  decodeBoxNames,
  decodeFcVersion,
  decodeRawGps,
  decodeRc,
  decodeStatus,
  encodeSetRawRc,
} from "./messages.js";

const bytes = (...values: number[]) => new Uint8Array(values);
const ascii = (text: string) => [...text].map((c) => c.charCodeAt(0));

describe("message decoders", () => {
  it("throws MspDecodeError on a truncated payload", () => {
    expect(() => decodeApiVersion(bytes(0, 1))).toThrow(MspDecodeError);
    expect(() => decodeApiVersion(bytes(0, 1))).toThrow("MSP_API_VERSION: payload too short (2 bytes)");
    expect(() => decodeStatus(bytes(1, 2, 3))).toThrow(MspDecodeError);
  });

  it("decodes pre-1.47 FC versions without a version string", () => {
    expect(decodeFcVersion(bytes(4, 5, 5))).toEqual({ major: 4, minor: 5, patch: 5 });
  });

  it("decodes short board info replies from older firmware", () => {
    const base = [...ascii("S7X2"), 1, 0, 2];
    expect(decodeBoardInfo(bytes(...base))).toEqual({ boardIdentifier: "S7X2", hardwareRevision: 1, boardType: 2 });
    expect(decodeBoardInfo(bytes(...base, 1, 4, ...ascii("STM7")))).toEqual({
      boardIdentifier: "S7X2",
      hardwareRevision: 1,
      boardType: 2,
      targetCapabilities: 1,
      targetName: "STM7",
    });
  });

  it("decodes GPS without PDOP and analog without the precise voltage", () => {
    const gps = decodeRawGps(bytes(1, 9, 0, 0, 0, 0, 0, 0, 0, 0, 12, 0, 100, 0, 0x10, 0x0e));
    expect(gps).toEqual({
      fix: true,
      numSat: 9,
      latitude: 0,
      longitude: 0,
      altitudeM: 12,
      groundSpeedCmS: 100,
      groundCourseDeg: 360,
    });
    expect(decodeAnalog(bytes(168, 10, 0, 0, 0, 0xf4, 0x01))).toEqual({ voltageV: 16.8, mAhDrawn: 10, rssi: 0, currentA: 5 });
  });

  it("reads extended flight mode flags and maps them through the box id list", () => {
    // 40 active boxes: bit 33 lives in the extra flag byte.
    const payload = bytes(
      0xe8, 0x03, 0, 0, 0x21, 0, // cycle time, i2c errors, sensors
      0x01, 0, 0, 0, // first 32 flag bits: box index 0
      0, 0x10, 0, 0, 0, // pid profile, cpu load, ex fields
      1, 0x02, // one extra flag byte: bit 33
      30, 0x04, 0, 0, 0, // arming disable flags (bit 2)
      0x01, // reboot required
    );
    const status = decodeStatus(payload);
    expect(status).toMatchObject({ cycleTimeUs: 1000, sensors: 0x21, cpuLoad: 16, armingDisableFlags: 4, rebootRequired: true });
    expect([...status.flightModeFlags]).toEqual([1, 0, 0, 0, 2]);

    const boxIds = Array.from({ length: 40 }, (_, i) => 100 + i);
    boxIds[0] = BoxId.ARM;
    boxIds[33] = BoxId.MSP_OVERRIDE;
    expect(activeBoxIds(status.flightModeFlags, boxIds)).toEqual(new Set([BoxId.ARM, BoxId.MSP_OVERRIDE]));
  });

  it("ignores box ids beyond the flag bytes the FC sent", () => {
    expect(activeBoxIds(bytes(0xff, 0xff, 0xff, 0xff), Array.from({ length: 40 }, (_, i) => i)).size).toBe(32);
  });

  it("ignores a trailing odd byte in MSP_RC and empty box names", () => {
    expect(decodeRc(bytes(0xdc, 0x05, 0xdc))).toEqual([1500]);
    expect(decodeBoxNames(bytes(...ascii("ARM;;ANGLE;")))).toEqual(["ARM", "ANGLE"]);
  });
});

describe("encodeSetRawRc", () => {
  it("packs channels as little-endian u16 in the given order", () => {
    expect([...encodeSetRawRc([1500, 1500, 1275, 1500])]).toEqual([0xdc, 0x05, 0xdc, 0x05, 0xfb, 0x04, 0xdc, 0x05]);
  });

  it("rejects empty, oversized and out-of-range channel lists", () => {
    expect(() => encodeSetRawRc([])).toThrow(RangeError);
    expect(() => encodeSetRawRc(new Array(MAX_RC_CHANNELS + 1).fill(1500))).toThrow(RangeError);
    expect(() => encodeSetRawRc([1500, -1])).toThrow("RC channel 1");
    expect(() => encodeSetRawRc([70000])).toThrow(RangeError);
    expect(() => encodeSetRawRc([1500.5])).toThrow(RangeError);
  });
});
