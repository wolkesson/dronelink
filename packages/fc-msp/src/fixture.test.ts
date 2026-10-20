/**
 * Decodes protocol/fixtures/betaflight-2026.6.2-sitl-msp.{bin,json}: real MSP replies recorded
 * from Betaflight 2026.6.2 SITL flying in ALT HOLD + POS HOLD with MSP OVERRIDE active
 * (tools/sitl/capture_msp_fixture.py).
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, it, expect } from "vitest";
import { MspParser, encodeMspRequest, encodeSetRawRc, type MspFrame } from "./index.js";
import {
  BoxId,
  MspCommand,
  activeBoxIds,
  decodeAltitude,
  decodeAnalog,
  decodeApiVersion,
  decodeAttitude,
  decodeBoardInfo,
  decodeBoxIds,
  decodeBoxNames,
  decodeBuildInfo,
  decodeCompGps,
  decodeFcVariant,
  decodeFcVersion,
  decodeGpsRescueConfig,
  decodeRawGps,
  decodeRc,
  decodeRxMap,
  decodeStatus,
} from "./messages.js";

interface FixtureRequest {
  name: string;
  command: number;
  mspVersion: 1 | 2;
  request: string;
  replyOffset: number;
  replyLength: number;
}

const fixtureBase = fileURLToPath(new URL("../../../protocol/fixtures/betaflight-2026.6.2-sitl-msp", import.meta.url));
const stream = new Uint8Array(readFileSync(`${fixtureBase}.bin`));
const meta = JSON.parse(readFileSync(`${fixtureBase}.json`, "utf8")) as { requests: FixtureRequest[] };

const hex = (data: Uint8Array) => Buffer.from(data).toString("hex");

function parseFixture(chunkSize: number): MspFrame[] {
  const parser = new MspParser();
  const frames: MspFrame[] = [];
  for (let offset = 0; offset < stream.length; offset += chunkSize) {
    frames.push(...parser.push(stream.subarray(offset, offset + chunkSize)));
  }
  expect(parser.stats).toEqual({ frames: meta.requests.length, checksumErrors: 0, oversizeFrames: 0, discardedBytes: 0 });
  return frames;
}

function reply(name: string, version: 1 | 2 = 1): MspFrame {
  const frames = parseFixture(stream.length);
  const index = meta.requests.findIndex((r) => r.name === name && r.mspVersion === version);
  expect(index).toBeGreaterThanOrEqual(0);
  return frames[index];
}

describe("Betaflight 2026.6.2 SITL fixture", () => {
  it("parses every reply, whole or in arbitrary chunks, matching the recorded framing", () => {
    for (const chunkSize of [stream.length, 1, 7, 64]) {
      const frames = parseFixture(chunkSize);
      expect(frames).toHaveLength(meta.requests.length);
      frames.forEach((frame, i) => {
        const request = meta.requests[i];
        expect(frame.command).toBe(request.command);
        expect(frame.version).toBe(request.mspVersion);
      });
    }
  });

  it("re-encodes every recorded request byte for byte", () => {
    for (const request of meta.requests) {
      const payload = request.command === MspCommand.SET_RAW_RC ? encodeSetRawRc([1500, 1500, 1275, 1500]) : undefined;
      expect(hex(encodeMspRequest(request.command, payload, request.mspVersion))).toBe(request.request);
    }
  });

  it("identifies Betaflight 2026.6.2 on MSP API 1.48", () => {
    expect(decodeApiVersion(reply("MSP_API_VERSION").payload)).toEqual({ protocolVersion: 0, apiMajor: 1, apiMinor: 48 });
    expect(decodeApiVersion(reply("MSP_API_VERSION", 2).payload)).toEqual({ protocolVersion: 0, apiMajor: 1, apiMinor: 48 });
    expect(decodeFcVariant(reply("MSP_FC_VARIANT").payload)).toBe("BTFL");
    expect(decodeFcVersion(reply("MSP_FC_VERSION").payload)).toEqual({ major: 26, minor: 6, patch: 2, versionString: "2026.6.2" });
    expect(decodeBoardInfo(reply("MSP_BOARD_INFO").payload)).toMatchObject({ boardIdentifier: "SITL", targetName: "SITL" });
    expect(decodeBuildInfo(reply("MSP_BUILD_INFO").payload).gitRevision).toMatch(/^[0-9a-f]{7}$/);
  });

  it("lists the boxes flight control needs, including the jumbo-framed box names", () => {
    const boxIds = decodeBoxIds(reply("MSP_BOXIDS").payload);
    expect(boxIds).toEqual(expect.arrayContaining([BoxId.ARM, BoxId.ALTHOLD, BoxId.POSHOLD, BoxId.MSP_OVERRIDE]));
    const names = decodeBoxNames(reply("MSP_BOXNAMES").payload);
    expect(names).toHaveLength(boxIds.length);
    expect(names[boxIds.indexOf(BoxId.MSP_OVERRIDE)]).toBe("MSP OVERRIDE");
    expect(names[boxIds.indexOf(BoxId.POSHOLD)]).toBe("POS HOLD");
  });

  it("reports the in-flight modes from STATUS and STATUS_EX, v1 and v2", () => {
    const boxIds = decodeBoxIds(reply("MSP_BOXIDS").payload);
    const expected = new Set([BoxId.ARM, BoxId.ANGLE, BoxId.ALTHOLD, BoxId.POSHOLD, BoxId.MSP_OVERRIDE]);
    for (const frame of [reply("MSP_STATUS"), reply("MSP_STATUS_EX"), reply("MSP_STATUS_EX", 2)]) {
      const status = decodeStatus(frame.payload);
      expect(activeBoxIds(status.flightModeFlags, boxIds)).toEqual(expected);
      expect(status.armingDisableFlags).toBe(0);
    }
  });

  it("maps sticks through the RX map and shows the hover throttle", () => {
    // rcmap AETR: roll, pitch, yaw, throttle live on raw channels 0, 1, 3, 2.
    expect(decodeRxMap(reply("MSP_RX_MAP").payload).slice(0, 4)).toEqual([0, 1, 3, 2]);
    expect(decodeRc(reply("MSP_RC").payload).slice(0, 8)).toEqual([1500, 1500, 1500, 1275, 2000, 2000, 2000, 2000]);
    expect(decodeGpsRescueConfig(reply("MSP_GPS_RESCUE").payload).hoverThrottle).toBe(1275);
  });

  it("decodes position, attitude, altitude and power telemetry", () => {
    const gps = decodeRawGps(reply("MSP_RAW_GPS").payload);
    expect(gps).toMatchObject({ fix: true, numSat: 12, latitude: -27.5, longitude: 153 });
    expect(decodeCompGps(reply("MSP_COMP_GPS").payload).distanceToHomeM).toBe(0);
    expect(decodeAttitude(reply("MSP_ATTITUDE").payload)).toMatchObject({ rollDeg: 0, pitchDeg: 0 });
    expect(decodeAltitude(reply("MSP_ALTITUDE").payload).altitudeM).toBeGreaterThan(3);
    expect(decodeAnalog(reply("MSP_ANALOG").payload)).toEqual({ voltageV: 0, mAhDrawn: 0, rssi: 0, currentA: 0 });
  });

  it("acknowledges MSP_SET_RAW_RC and errors on an unassigned command", () => {
    expect(reply("MSP_SET_RAW_RC")).toMatchObject({ direction: "response", command: 200, payload: new Uint8Array(0) });
    expect(reply("unassigned command 20")).toMatchObject({ direction: "error", command: 20 });
  });
});
