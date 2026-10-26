import { describe, expect, it } from "vitest";
import template from "../../../../docs/flight/betaflight-dronelink.cli?raw";
import { BoxId } from "@dronelink/fc-msp";
import { DEFAULT_FC_IDENTIFICATION_CONFIG } from "./FcIdentificationGate.js";
import { DEFAULT_SUPERVISOR_CONFIG } from "./FlightControlSupervisor.js";

/**
 * docs/flight/betaflight-dronelink.cli is the Betaflight configuration the safety pilot applies
 * (#90). Most of it can't be read over MSP, so nothing at runtime checks it: these tests keep it
 * in line with what the gate and the supervisor assume. tools/sitl/check_betaflight_template.py
 * additionally loads it into Betaflight SITL.
 */
const commands = template
  .split("\n")
  .map((line) => line.split("#")[0].trim())
  .filter((line) => line.length > 0);

const settings = new Map(
  commands.flatMap((line) => {
    const match = /^set\s+(\S+)\s*=\s*(.+)$/.exec(line);
    return match ? [[match[1], match[2].trim()] as const] : [];
  }),
);

interface AuxRange {
  box: number;
  aux: number;
  low: number;
  high: number;
}

const auxRanges: AuxRange[] = commands
  .filter((line) => line.startsWith("aux "))
  .map((line) => {
    const [, , box, aux, low, high] = line.split(/\s+/).map(Number);
    return { box, aux, low, high };
  });

const rangeOf = (box: number) => auxRanges.find((range) => range.box === box);
const STICK_HALF_TRAVEL_US = 500;

describe("Betaflight configuration template", () => {
  it("names a firmware the identification gate accepts", () => {
    const firmware = /^# Firmware: Betaflight (\S+)/m.exec(template)?.[1];
    expect(DEFAULT_FC_IDENTIFICATION_CONFIG.supportedVersions).toContain(firmware);
  });

  it("overrides exactly the four stick channels, never an AUX channel", () => {
    expect(settings.get("msp_override_channels_mask")).toBe("15");
  });

  it("keeps Betaflight's RX failsafe in charge of the SP's link", () => {
    expect(settings.get("msp_override_failsafe")).toBe("OFF");
  });

  it("fixes a non-zero hover throttle (the gate rejects 0)", () => {
    expect(Number(settings.get("ap_hover_throttle"))).toBeGreaterThan(0);
  });

  it("uses the deadbands the supervisor's unlock tolerances fit inside", () => {
    const posHoldDeadbandUs = (Number(settings.get("pos_hold_deadband")) / 100) * STICK_HALF_TRAVEL_US;
    const altHoldDeadbandUs = (Number(settings.get("alt_hold_deadband")) / 100) * STICK_HALF_TRAVEL_US;
    expect(DEFAULT_SUPERVISOR_CONFIG.stickNeutralToleranceUs).toBeLessThanOrEqual(posHoldDeadbandUs);
    expect(DEFAULT_SUPERVISOR_CONFIG.throttleNeutralToleranceUs).toBeLessThanOrEqual(altHoldDeadbandUs);
  });

  it("asks for at least the satellites the supervisor needs before a handover", () => {
    expect(Number(settings.get("gps_rescue_min_sats"))).toBeGreaterThanOrEqual(DEFAULT_SUPERVISOR_CONFIG.minSats);
  });

  it("puts the modes the gate requires on switches, with the handover switch on its own", () => {
    for (const box of [BoxId.ARM, BoxId.ALTHOLD, BoxId.POSHOLD, BoxId.MSP_OVERRIDE]) expect(rangeOf(box)).toBeDefined();
    const handover = rangeOf(BoxId.MSP_OVERRIDE)!;
    expect(auxRanges.filter((range) => range.aux === handover.aux)).toEqual([handover]);
  });

  it("engages ALT HOLD and POS HOLD together, from one switch", () => {
    const { box: _alt, ...alt } = rangeOf(BoxId.ALTHOLD)!;
    const { box: _pos, ...pos } = rangeOf(BoxId.POSHOLD)!;
    expect(pos).toEqual(alt);
  });

  it("ends with save", () => {
    expect(commands.at(-1)).toBe("save");
  });
});
