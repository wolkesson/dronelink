import { describe, expect, it, vi } from "vitest";
import { MspCommand } from "@dronelink/fc-msp";
import { FcIdentificationGate, type FcIdentificationOptions } from "./FcIdentificationGate.js";

const ascii = (text: string) => [...text].map((char) => char.charCodeAt(0));
const u16 = (value: number) => [value & 0xff, value >> 8];

function replies(overrides: Partial<Record<number, Uint8Array>> = {}): Record<number, Uint8Array> {
  const build = new Uint8Array(26);
  build.set(ascii("20260601AAA"));
  build.set(ascii("12000000"), 11);
  build.set(ascii("abcdefg"), 19);
  const rescue = new Uint8Array(18);
  rescue.set(u16(1275), 12);
  return {
    [MspCommand.API_VERSION]: new Uint8Array([0, 1, 48]),
    [MspCommand.FC_VARIANT]: new Uint8Array(ascii("BTFL")),
    [MspCommand.FC_VERSION]: new Uint8Array([26, 6, 1, 8, ...ascii("2026.6.1")]),
    [MspCommand.BOARD_INFO]: new Uint8Array([
      ...ascii("S7X2"), ...u16(1), 2, 1, 4, ...ascii("STM7"), 5, ...ascii("Board"), 3, ...ascii("ACM"),
    ]),
    [MspCommand.BUILD_INFO]: build,
    [MspCommand.BOXNAMES]: new Uint8Array(ascii("ARM;ALTHOLD;POS HOLD;MSP OVERRIDE;")),
    [MspCommand.BOXIDS]: new Uint8Array([0, 3, 11, 50]),
    [MspCommand.RX_MAP]: new Uint8Array([0, 1, 2, 3]),
    [MspCommand.GPS_RESCUE]: rescue,
    ...overrides,
  };
}

function options(overrides: Partial<FcIdentificationOptions> = {}): FcIdentificationOptions {
  const responses = replies();
  return {
    enabled: true,
    detectedType: "msp-v1",
    passthroughIdle: true,
    request: vi.fn(async (command: number) => responses[command] ?? null),
    ...overrides,
  };
}

describe("FcIdentificationGate", () => {
  it("verifies supported Betaflight and emits its identity", async () => {
    const gate = new FcIdentificationGate();
    const onIdentity = vi.fn();
    const request = options({ onIdentity });

    await expect(gate.identify(request)).resolves.toMatchObject({
      mode: "verified",
      identity: { variant: "BTFL", version: "2026.6.1", apiVersion: "1.48", board: "Board", hoverThrottleUs: 1275 },
    });
    expect(request.request).toHaveBeenCalledTimes(9);
    expect(onIdentity).toHaveBeenCalledOnce();
  });

  it("does not probe when disabled, when another protocol is detected, or while passthrough is busy", async () => {
    const gate = new FcIdentificationGate();
    const disabled = options({ enabled: false });
    await expect(gate.identify(disabled)).resolves.toMatchObject({ mode: "transparent", reason: "setting-disabled" });
    expect(disabled.request).not.toHaveBeenCalled();

    const mavlink = options({ detectedType: "mavlink-v2" });
    await expect(gate.identify(mavlink)).resolves.toMatchObject({ mode: "transparent", reason: "unsupported-link-type" });
    expect(mavlink.request).not.toHaveBeenCalled();

    const busy = options({ passthroughIdle: false });
    await expect(gate.identify(busy)).resolves.toMatchObject({ mode: "pending", reason: "passthrough-busy" });
    expect(busy.request).not.toHaveBeenCalled();
  });

  it.each([
    ["unsupported-api-version", MspCommand.API_VERSION, new Uint8Array([0, 1, 47])],
    ["unsupported-api-version", MspCommand.API_VERSION, new Uint8Array([1, 1, 48])],
    ["unsupported-api-version", MspCommand.API_VERSION, new Uint8Array([0, 2, 48])],
    ["unsupported-api-version", MspCommand.API_VERSION, new Uint8Array([0, 1, 49])],
    ["unsupported-firmware", MspCommand.FC_VARIANT, new Uint8Array(ascii("INAV"))],
    ["unsupported-firmware-version", MspCommand.FC_VERSION, new Uint8Array([25, 12, 0, 9, ...ascii("2025.12.0")])],
    ["unsupported-firmware-version", MspCommand.FC_VERSION, new Uint8Array([26, 6, 3])],
    ["missing-boxes:50", MspCommand.BOXIDS, new Uint8Array([0, 3, 11])],
    ["missing-boxes:11", MspCommand.BOXIDS, new Uint8Array([0, 3, 50])],
    ["malformed-boxes", MspCommand.BOXNAMES, new Uint8Array(ascii("ARM;ALTHOLD;POS HOLD;NOT OVERRIDE;"))],
    ["malformed-boxes", MspCommand.BOXNAMES, new Uint8Array(ascii("ARM;ALTHOLD;POS HOLD;"))],
    ["unsupported-rx-map", MspCommand.RX_MAP, new Uint8Array([0, 1, 2, 4])],
    ["unsupported-rx-map", MspCommand.RX_MAP, new Uint8Array([0, 1, 1, 3])],
    ["unsupported-rx-map", MspCommand.RX_MAP, new Uint8Array([0, 1, 2])],
  ])("rejects FC that fails %s", async (reason, command, payload) => {
    const gate = new FcIdentificationGate();
    const request = vi.fn(async (requested: number) => replies({ [command]: payload })[requested] ?? null);
    await expect(gate.identify(options({ request })))
      .resolves.toMatchObject({ mode: "transparent", reason });
    expect(request).not.toHaveBeenCalledWith(MspCommand.SET_RAW_RC);
  });

  it("rejects a zero hover throttle and malformed or missing replies", async () => {
    const zeroThrottle = replies();
    zeroThrottle[MspCommand.GPS_RESCUE] = new Uint8Array(18);
    await expect(new FcIdentificationGate().identify(options({ request: async (command) => zeroThrottle[command] ?? null })))
      .resolves.toMatchObject({ mode: "transparent", reason: "hover-throttle-not-fixed" });

    await expect(new FcIdentificationGate().identify(options({ request: async () => null })))
      .resolves.toMatchObject({ mode: "transparent", reason: "identification-timeout" });

    const timedOutGate = new FcIdentificationGate({
      supportedVersions: ["2026.6.1"],
      supportedApiMajor: 1,
      minApiMinor: 48,
      maxApiMinor: 48,
      timeoutMs: 1,
    });
    await expect(timedOutGate.identify(options({ request: () => new Promise(() => {}) })))
      .resolves.toMatchObject({ mode: "transparent", reason: "identification-timeout" });

    const malformed = replies({ [MspCommand.API_VERSION]: new Uint8Array([0]) });
    await expect(new FcIdentificationGate().identify(options({ request: async (command) => malformed[command] ?? null })))
      .resolves.toMatchObject({ mode: "transparent", reason: "malformed-identification-reply" });
  });

  it("supports the version tuple when the version string is unavailable", async () => {
    const noString = replies({ [MspCommand.FC_VERSION]: new Uint8Array([26, 6, 1]) });
    const gate = new FcIdentificationGate();
    await expect(gate.identify(options({ request: async (command) => noString[command] ?? null })))
      .resolves.toMatchObject({ mode: "verified", identity: { version: "2026.6.1" } });
  });

  it("accepts available box names without board target or name fields", async () => {
    const minimalBoard = new Uint8Array([...ascii("S7X2"), ...u16(1), 2]);
    const payloads = replies({ [MspCommand.BOARD_INFO]: minimalBoard });
    await expect(new FcIdentificationGate().identify(options({ request: async (command) => payloads[command] ?? null })))
      .resolves.toMatchObject({ mode: "verified", identity: { board: "S7X2", target: "S7X2" } });
  });

  it("disabling during an outstanding probe cancels verification", async () => {
    const gate = new FcIdentificationGate({ supportedVersions: ["2026.6.1"], supportedApiMajor: 1, minApiMinor: 48, maxApiMinor: 48, timeoutMs: 100 });
    expect(gate.result).toMatchObject({ mode: "transparent", reason: "setting-disabled" });
    gate.reset();
    expect(gate.result).toMatchObject({ mode: "transparent", reason: "link-reopened" });
    let resolve!: (payload: Uint8Array | null) => void;
    const request = options({ request: () => new Promise((done) => { resolve = done; }) });
    const running = gate.identify(request);
    gate.disable();
    resolve(new Uint8Array([0, 1, 48]));
    await expect(running).resolves.toMatchObject({ mode: "transparent", reason: "setting-disabled" });
  });

  it("returns to transparent when the request transport rejects", async () => {
    await expect(new FcIdentificationGate().identify(options({ request: async () => { throw new Error("serial failed"); } })))
      .resolves.toMatchObject({ mode: "transparent", reason: "malformed-identification-reply" });
  });
});
