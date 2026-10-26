import { readFileSync } from "node:fs";
import Ajv from "ajv";
import { describe, it, expect } from "vitest";
import {
  FLIGHT_CONTROL_CHANNEL_INIT,
  FLIGHT_CONTROL_CHANNEL_LABEL,
  parseFlightControlAirMessage,
  parseFlightControlGroundMessage,
  type FlightControlState,
} from "./flight-control.js";

function loadSchema(name: string): object {
  return JSON.parse(readFileSync(new URL(`../../../protocol/schemas/${name}`, import.meta.url), "utf8")) as object;
}

const ajv = new Ajv({ allErrors: true });
const commandSchema = ajv.compile(loadSchema("flight-control-command.schema.json"));
const stateSchema = ajv.compile(loadSchema("flight-control-state.schema.json"));

const validCommands: unknown[] = [
  { type: "fc-command", seq: 0, sentAt: 1760000000000, roll: 0, pitch: 0, yaw: 0, throttle: 0 },
  { type: "fc-command", seq: 42, sentAt: 0, roll: -1, pitch: 1, yaw: 0.25, throttle: -0.5 },
  { type: "fc-control", action: "unlock" },
  { type: "fc-control", action: "abort" },
  { type: "fc-control", action: "release" },
  { type: "fc-setting", flightControlEnabled: true },
  { type: "fc-setting", flightControlEnabled: false },
];

const fullState: FlightControlState = {
  type: "fc-state",
  sentAt: 1760000000123,
  flightControlEnabled: true,
  link: { mode: "verified", reason: null, detectedType: "msp-v1" },
  fc: { variant: "BTFL", version: "2026.6.2", apiVersion: "1.48", board: "SITL" },
  supervisor: { state: "ACTIVE", reason: "unlocked", lastAppliedSeq: 1234 },
  telemetry: {
    armed: true,
    modes: ["ANGLE", "ALTHOLD", "POSHOLD", "MSP_OVERRIDE"],
    rxFailsafe: false,
    gps: { fix: true, numSat: 12, latitude: -27.5, longitude: 153 },
    altitudeM: 4.57,
    varioMS: 0,
    headingDeg: 358,
    rollDeg: 0.1,
    pitchDeg: -2.5,
    voltageV: 16.8,
    sticksUs: [1500, 1650, 1500, 1275],
  },
  limits: {
    commandRateHz: 20,
    neutralTimeoutMs: 250,
    releaseTimeoutMs: 1000,
    hoverThrottleUs: 1275,
    maxDeflectionUs: { roll: 150, pitch: 150, yaw: 150, throttle: 150 },
  },
  rejectedMessages: 0,
};

const validAirMessages: unknown[] = [
  fullState,
  {
    ...fullState,
    flightControlEnabled: false,
    link: { mode: "transparent", reason: "setting-disabled", detectedType: "silent" },
    fc: null,
    supervisor: { state: "IDLE", reason: null, lastAppliedSeq: null },
    telemetry: null,
    limits: { ...fullState.limits, hoverThrottleUs: null },
  },
  {
    ...fullState,
    telemetry: { ...fullState.telemetry!, modes: [], gps: { fix: false, numSat: 0, latitude: null, longitude: null }, altitudeM: null, sticksUs: null },
  },
  { type: "fc-channel", open: true },
  { type: "fc-channel", open: false },
];

// Representable in JSON, so both the schema and the parser must agree on every one.
const REPLACEMENTS: unknown[] = ["x", "", 0, -1, 1, 1.5, -2, 2, 255, 9007199254740992, null, true, false, [], {}, ["ANGLE"], ["ANGLE", "ANGLE"]];

/** Every message obtainable from `value` by deleting, replacing or adding one property at any depth. */
function mutations(value: unknown): unknown[] {
  const results: unknown[] = REPLACEMENTS.slice();
  if (Array.isArray(value)) {
    value.forEach((item, index) => {
      for (const variant of mutations(item)) {
        const copy = value.slice();
        copy[index] = variant;
        results.push(copy);
      }
    });
    results.push([...value, value[0] ?? "ANGLE"]);
  } else if (typeof value === "object" && value !== null) {
    const record = value as Record<string, unknown>;
    for (const key of Object.keys(record)) {
      const { [key]: _removed, ...without } = record;
      results.push(without);
      for (const variant of mutations(record[key])) {
        results.push({ ...record, [key]: variant });
      }
    }
    results.push({ ...record, unexpected: 1 });
  }
  return results;
}

describe("flight-control channel constants", () => {
  it("names an unordered channel that never retransmits", () => {
    expect(FLIGHT_CONTROL_CHANNEL_LABEL).toBe("flight-control");
    expect(FLIGHT_CONTROL_CHANNEL_INIT).toEqual({ ordered: false, maxRetransmits: 0 });
  });
});

describe("parseFlightControlGroundMessage", () => {
  it("accepts every valid command, and the schema agrees", () => {
    for (const message of validCommands) {
      expect(commandSchema(message)).toBe(true);
      expect(parseFlightControlGroundMessage(message)).toBe(message);
    }
  });

  it("agrees with flight-control-command.schema.json on every single-property mutation", () => {
    let checked = 0;
    for (const message of validCommands) {
      for (const mutant of mutations(message)) {
        const schemaOk = commandSchema(mutant) as boolean;
        const parserOk = parseFlightControlGroundMessage(mutant) !== null;
        expect({ mutant, parserOk }).toEqual({ mutant, parserOk: schemaOk });
        checked++;
      }
    }
    expect(checked).toBeGreaterThan(300);
  });

  it("rejects values JSON cannot carry and air -> ground message types", () => {
    const base = validCommands[0] as Record<string, unknown>;
    expect(parseFlightControlGroundMessage({ ...base, roll: Number.NaN })).toBeNull();
    expect(parseFlightControlGroundMessage({ ...base, sentAt: Number.POSITIVE_INFINITY })).toBeNull();
    expect(parseFlightControlGroundMessage({ type: "fc-channel", open: true })).toBeNull();
    expect(parseFlightControlGroundMessage(undefined)).toBeNull();
  });
});

describe("parseFlightControlAirMessage", () => {
  it("accepts every valid state and channel notice, and the schema agrees", () => {
    for (const message of validAirMessages) {
      expect(stateSchema(message)).toBe(true);
      expect(parseFlightControlAirMessage(message)).toBe(message);
    }
  });

  it("agrees with flight-control-state.schema.json on every single-property mutation", () => {
    let checked = 0;
    for (const message of validAirMessages) {
      for (const mutant of mutations(message)) {
        const schemaOk = stateSchema(mutant) as boolean;
        const parserOk = parseFlightControlAirMessage(mutant) !== null;
        expect({ mutant, parserOk }).toEqual({ mutant, parserOk: schemaOk });
        checked++;
      }
    }
    expect(checked).toBeGreaterThan(2000);
  });

  it("rejects ground -> air messages and non-finite numbers", () => {
    expect(parseFlightControlAirMessage(validCommands[0])).toBeNull();
    expect(parseFlightControlAirMessage({ ...fullState, sentAt: Number.NaN })).toBeNull();
    expect(parseFlightControlAirMessage("fc-state")).toBeNull();
  });
});
