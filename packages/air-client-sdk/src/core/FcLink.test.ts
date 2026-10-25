import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MspCommand, encodeMspV1, encodeMspV2 } from "@dronelink/fc-msp";
import { FcLink, TELEMETRY_COMMANDS, type FcLinkEvent } from "./FcLink.js";
import { FakeFc, identificationReplies, statusPayload, u16 } from "./testing/FakeFc.js";

function setup(flightControlEnabled: boolean, config = {}) {
  const fc = new FakeFc();
  const link = new FcLink({ transport: fc, flightControlEnabled, config });
  const toGround: Uint8Array[] = [];
  const events: FcLinkEvent[] = [];
  link.onGroundBound((bytes) => toGround.push(bytes));
  link.onChange((event) => events.push(event));
  return { fc, link, toGround, events };
}

async function untilControl(link: FcLink): Promise<void> {
  await vi.advanceTimersByTimeAsync(2_100);
  expect(link.mode).toBe("control");
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("FcLink passthrough", () => {
  it("relays byte-identically in both directions and never writes on its own with the setting off", async () => {
    const { fc, link, toGround } = setup(false);
    link.start();
    const fromFc = [new Uint8Array([0x24, 0x4d, 0x3e, 0x00]), new Uint8Array([0x65, 0x65]), new Uint8Array([0xfd, 1, 2, 3])];
    const fromGround = [new Uint8Array([0x24, 0x4d, 0x3c, 0x00, 0x65, 0x65]), new Uint8Array([7, 8, 9])];

    for (const chunk of fromFc) fc.emit(chunk);
    for (const chunk of fromGround) link.writeFromGround(chunk);
    await vi.advanceTimersByTimeAsync(30_000);

    expect(toGround).toEqual(fromFc);
    toGround.forEach((chunk, index) => expect(chunk).toBe(fromFc[index]));
    expect(fc.writes).toEqual(fromGround);
    fc.writes.forEach((chunk, index) => expect(chunk).toBe(fromGround[index]));
    expect(link.mode).toBe("passthrough");
    expect(link.identification).toMatchObject({ mode: "transparent", reason: "link-opened" });
    expect(link.sendRc([1500, 1500, 1500, 1500])).toBe(false);
    expect(fc.count(MspCommand.SET_RAW_RC)).toBe(0);
  });

  it("classifies the FC stream passively and reports silence", async () => {
    const { fc, link, events } = setup(false);
    link.start();
    expect(link.detectedType).toBe("unknown");
    await vi.advanceTimersByTimeAsync(2_100);
    expect(link.detectedType).toBe("silent");
    fc.emit(encodeMspV2("response", 0x1001, new Uint8Array([1])));
    expect(link.detectedType).toBe("msp-v2");
    expect(events).toContain("identification");
  });

  it("ignores empty ground writes and stops on an empty chunk from the transport", () => {
    const { fc, link, events } = setup(false);
    link.writeFromGround(new Uint8Array([1])); // before start: still relayed, nothing to gate yet
    link.start();
    link.start();
    link.writeFromGround(new Uint8Array(0));
    expect(fc.writes).toHaveLength(1);
    fc.emit(new Uint8Array(0));
    expect(events).toContain("closed");
    expect(fc.subscribed).toBe(false);
    link.writeFromGround(new Uint8Array([2]));
    link.stop();
    expect(fc.writes).toHaveLength(1);
    expect(events.filter((event) => event === "closed")).toHaveLength(1);
  });

  it("swallows a failed relay write", async () => {
    const { fc, link } = setup(false);
    link.start();
    fc.write = () => Promise.reject(new Error("unplugged"));
    link.writeFromGround(new Uint8Array([1]));
    await vi.advanceTimersByTimeAsync(10);
    expect(link.mode).toBe("passthrough");
  });
});

describe("FcLink identification", () => {
  it("waits for an idle passthrough before probing", async () => {
    const { fc, link } = setup(true);
    link.start();
    await vi.advanceTimersByTimeAsync(1_500);
    link.writeFromGround(new Uint8Array([9]));
    await vi.advanceTimersByTimeAsync(1_500);
    expect(fc.requests).toEqual([]);
    expect(link.identification).toMatchObject({ mode: "pending", reason: "passthrough-busy" });
    link.writeFromGround(new Uint8Array([9]));
    await vi.advanceTimersByTimeAsync(2_100);
    expect(fc.requests[0]).toBe(MspCommand.API_VERSION);
  });

  it("never probes a link that is clearly another protocol", async () => {
    const { fc, link, toGround } = setup(true);
    link.start();
    const heartbeat = new Uint8Array([0xfd, 9, 0, 0, 0, 1, 1, 0, 0, 0, ...new Array(9).fill(0), 0x12, 0x34]);
    fc.emit(heartbeat);
    await vi.advanceTimersByTimeAsync(100);
    expect(link.detectedType).toBe("mavlink-v2");
    await vi.advanceTimersByTimeAsync(10_000);
    expect(fc.writes).toEqual([]);
    expect(link.identification).toMatchObject({ mode: "transparent", reason: "unsupported-link-type" });
    expect(toGround).toEqual([heartbeat]);
  });

  it("keeps a rejected FC transparent and swallows the probe replies", async () => {
    const { fc, link, toGround } = setup(true);
    fc.replies = { ...fc.replies, ...identificationReplies("INAV") };
    link.start();
    await vi.advanceTimersByTimeAsync(2_100);
    expect(link.identification).toMatchObject({ mode: "transparent", reason: "unsupported-firmware" });
    expect(link.mode).toBe("passthrough");
    expect(toGround).toEqual([]);
    const writesAfter = fc.writes.length;
    await vi.advanceTimersByTimeAsync(30_000);
    expect(fc.writes).toHaveLength(writesAfter);
    expect(fc.count(MspCommand.SET_RAW_RC)).toBe(0);

    const later = new Uint8Array([1, 2, 3]);
    fc.emit(later);
    expect(toGround).toEqual([later]);
  });

  it("treats an FC that never answers as transparent", async () => {
    const { fc, link } = setup(true);
    fc.responding = false;
    link.start();
    await vi.advanceTimersByTimeAsync(4_000);
    expect(link.identification).toMatchObject({ mode: "transparent", reason: "identification-timeout" });
    expect(link.mode).toBe("passthrough");
  });

  it("treats an MSP error reply as a failed identification", async () => {
    const { fc, link } = setup(true);
    fc.replies[MspCommand.FC_VARIANT] = "error";
    link.start();
    await vi.advanceTimersByTimeAsync(2_100);
    expect(link.identification).toMatchObject({ mode: "transparent", reason: "identification-timeout" });
  });

  it("re-identifies when the setting is turned off and on again", async () => {
    const { fc, link } = setup(true);
    fc.replies = { ...fc.replies, ...identificationReplies("INAV") };
    link.start();
    await vi.advanceTimersByTimeAsync(2_100);
    fc.replies = { ...fc.replies, ...identificationReplies() };
    link.setFlightControlEnabled(true);
    link.setFlightControlEnabled(false);
    expect(link.identification).toMatchObject({ mode: "transparent", reason: "setting-disabled" });
    link.setFlightControlEnabled(true);
    await vi.advanceTimersByTimeAsync(100);
    expect(link.mode).toBe("control");
  });

  it("holds ground bytes that arrive mid-identification, then relays them once its probe settles", async () => {
    const { fc, link, toGround } = setup(true);
    fc.responding = false;
    link.start();
    await vi.advanceTimersByTimeAsync(2_100);
    expect(link.mode).toBe("identifying");
    const configurator = new Uint8Array([0x24, 0x4d, 0x3c, 0, 1, 1]);
    const writesBefore = fc.writes.length;
    link.writeFromGround(configurator);
    link.writeFromGround(configurator);
    expect(fc.writes).toHaveLength(writesBefore);

    fc.emit(encodeMspV1("response", MspCommand.API_VERSION, new Uint8Array([0, 1, 48]))); // late probe reply
    await vi.advanceTimersByTimeAsync(0);
    expect(link.mode).toBe("passthrough");
    expect(fc.writes.slice(writesBefore)).toEqual([configurator, configurator]);
    expect(toGround).toEqual([]);
    expect(link.identification).toMatchObject({ mode: "pending", reason: "passthrough-busy" });

    fc.responding = true;
    await vi.advanceTimersByTimeAsync(2_100);
    expect(link.mode).toBe("control");
  });

  it("ends a cancelled probe after the guard time and drops ground bytes beyond the hold limit", async () => {
    const { fc, link } = setup(true, { maxHeldGroundBytes: 4 });
    link.start();
    fc.responding = false;
    await vi.advanceTimersByTimeAsync(2_100);
    expect(link.mode).toBe("identifying");
    link.writeFromGround(new Uint8Array([1, 2, 3]));
    link.writeFromGround(new Uint8Array([4, 5]));
    expect(link.droppedGroundBytes).toBe(2);
    await vi.advanceTimersByTimeAsync(149);
    expect(link.mode).toBe("identifying");
    await vi.advanceTimersByTimeAsync(1);
    expect(link.mode).toBe("passthrough");
    expect(fc.writes.at(-1)).toEqual(new Uint8Array([1, 2, 3]));
  });

  it("returns to passthrough when the setting is turned off mid-identification", async () => {
    const { fc, link } = setup(true);
    link.start();
    fc.responding = false;
    await vi.advanceTimersByTimeAsync(2_100);
    link.setFlightControlEnabled(false);
    await vi.advanceTimersByTimeAsync(150);
    expect(link.mode).toBe("passthrough");
    expect(link.identification).toMatchObject({ mode: "transparent", reason: "setting-disabled" });
    await vi.advanceTimersByTimeAsync(10_000);
    expect(link.mode).toBe("passthrough");
  });

  it("waits out the guard when the cancelled probe is still being written", async () => {
    const { fc, link } = setup(true);
    let release: (() => void) | null = null;
    const write = fc.write.bind(fc);
    link.start();
    await vi.advanceTimersByTimeAsync(1_999);
    fc.write = (data) => new Promise<void>((resolve) => {
      release = () => void write(data).then(resolve);
    });
    await vi.advanceTimersByTimeAsync(101);
    expect(link.mode).toBe("identifying");
    link.setFlightControlEnabled(false);
    expect(link.mode).toBe("identifying"); // the API_VERSION probe is still outstanding
    await vi.advanceTimersByTimeAsync(150);
    expect(link.mode).toBe("passthrough");
    release!();
  });

  it("stops cleanly while identifying", async () => {
    const { fc, link, events } = setup(true);
    link.start();
    fc.responding = false;
    await vi.advanceTimersByTimeAsync(2_100);
    link.stop();
    await vi.advanceTimersByTimeAsync(5_000);
    expect(events).toContain("closed");
    expect(link.identification).toMatchObject({ mode: "transparent", reason: "link-closed" });
  });
});

describe("FcLink control mode", () => {
  it("suspends the passthrough in both directions once verified", async () => {
    const { fc, link, toGround } = setup(true);
    link.start();
    await untilControl(link);
    expect(link.identification).toMatchObject({ mode: "verified", identity: { rxMap: [1, 0, 3, 2], boxIds: [0, 3, 11, 50] } });

    link.writeFromGround(new Uint8Array([1, 2, 3]));
    expect(link.droppedGroundBytes).toBe(3);
    fc.emit(new Uint8Array([4, 5, 6]));
    expect(toGround).toEqual([]);
    expect(fc.writes.some((write) => write.length === 3 && write[0] === 1)).toBe(false);
  });

  it("polls telemetry round-robin within the serial budget and decodes it", async () => {
    const { fc, link, events } = setup(true);
    link.start();
    await untilControl(link);
    await vi.advanceTimersByTimeAsync(20 * TELEMETRY_COMMANDS.length * 3);
    const polled = fc.requests.slice(9); // after the nine identification probes
    expect(polled.slice(0, TELEMETRY_COMMANDS.length)).toEqual([...TELEMETRY_COMMANDS]);
    const before = fc.requests.length;
    await vi.advanceTimersByTimeAsync(1_000);
    expect(fc.requests.length - before).toBeLessThanOrEqual(50); // one request per 20 ms at most
    expect(events).toContain("telemetry");

    const t = link.telemetry;
    expect(t.status).toMatchObject({ armed: true, rxFailsafe: false });
    expect([...t.status!.activeBoxes]).toEqual([0, 3, 11, 50]);
    expect(t.rc?.channels).toEqual([1500, 1501, 1502, 1300, 1900]);
    expect(t.attitude).toMatchObject({ rollDeg: -1.5, pitchDeg: 2.5, headingDeg: 270 });
    expect(t.altitude).toMatchObject({ altitudeM: 12.34, varioMS: -0.5 });
    expect(t.rawGps).toMatchObject({ fix: true, numSat: 12 });
    expect(t.compGps).toMatchObject({ distanceToHomeM: 42 });
    expect(t.analog).toMatchObject({ voltageV: 16.8 });
    expect(link.healthy).toBe(true);
  });

  it("reports RX failsafe from either the FAILSAFE box or the arming disable flag", async () => {
    const { fc, link } = setup(true);
    link.start();
    fc.replies[MspCommand.STATUS_EX] = statusPayload(0b0001, 1 << 2);
    await untilControl(link);
    await vi.advanceTimersByTimeAsync(200);
    expect(link.telemetry.status).toMatchObject({ armed: true, rxFailsafe: true });
  });

  it("keeps the previous value on a malformed reply and ignores unsolicited ones", async () => {
    const { fc, link } = setup(true);
    link.start();
    await untilControl(link);
    await vi.advanceTimersByTimeAsync(200);
    fc.replies[MspCommand.ATTITUDE] = new Uint8Array([1]);
    fc.replies[MspCommand.ALTITUDE] = "error";
    await vi.advanceTimersByTimeAsync(200);
    expect(link.telemetry.attitude).toMatchObject({ rollDeg: -1.5 });
    expect(link.telemetry.altitude).toMatchObject({ altitudeM: 12.34 });
    fc.emit(encodeMspV1("response", MspCommand.BOXIDS, new Uint8Array([0])));
    fc.emit(encodeMspV1("request", MspCommand.STATUS_EX));
    expect(link.healthy).toBe(true);
  });

  it("writes only four-channel MSP_SET_RAW_RC frames, ahead of queued telemetry", async () => {
    const { fc, link } = setup(true);
    link.start();
    await untilControl(link);
    let release: (() => void) | null = null;
    const write = fc.write.bind(fc);
    fc.write = (data) => {
      fc.write = write;
      return new Promise<void>((resolve) => {
        release = () => void write(data).then(resolve);
      });
    };
    await vi.advanceTimersByTimeAsync(20); // a telemetry write is now stuck in flight
    expect(link.sendRc([1400, 1500, 1500, 1300])).toBe(true);
    expect(link.sendRc([1450, 1500, 1500, 1300])).toBe(true); // replaces the unwritten one
    release!();
    await vi.advanceTimersByTimeAsync(0);
    const rcFrames = fc.writes.filter((frame) => frame[4] === MspCommand.SET_RAW_RC);
    expect(rcFrames).toEqual([encodeMspV1("request", MspCommand.SET_RAW_RC, new Uint8Array([...u16(1450), ...u16(1500), ...u16(1500), ...u16(1300)]))]);
    expect(link.rcFramesSent).toBe(1);
    expect(() => link.sendRc([1500, 1500, 1500, 1500, 1000])).toThrow(RangeError);
  });

  it("does not count a failed RC write as sent", async () => {
    const { fc, link } = setup(true);
    link.start();
    await untilControl(link);
    fc.write = () => Promise.reject(new Error("unplugged"));
    link.sendRc([1500, 1500, 1500, 1500]);
    await vi.advanceTimersByTimeAsync(0);
    expect(link.rcFramesSent).toBe(0);
  });

  it("reports fc-link-lost after the health timeout and re-identifies when replies return", async () => {
    const { fc, link, events } = setup(true);
    link.start();
    await untilControl(link);
    fc.responding = false;
    await vi.advanceTimersByTimeAsync(480);
    expect(link.healthy).toBe(true);
    await vi.advanceTimersByTimeAsync(40);
    expect(link.healthy).toBe(false);
    expect(events.filter((event) => event === "health")).toHaveLength(1);
    expect(link.sendRc([1500, 1500, 1500, 1500])).toBe(true); // still control mode; the supervisor releases

    fc.responding = true;
    const before = fc.count(MspCommand.API_VERSION);
    fc.emit(encodeMspV1("response", MspCommand.STATUS_EX, statusPayload(0)));
    expect(link.mode).toBe("identifying");
    expect(link.sendRc([1500, 1500, 1500, 1500])).toBe(false);
    expect(link.telemetry.status).toBeNull();
    await vi.advanceTimersByTimeAsync(10);
    expect(fc.count(MspCommand.API_VERSION)).toBe(before + 1);
    expect(link.mode).toBe("control");
    expect(link.healthy).toBe(true);
  });

  it("falls back to passthrough when re-identification finds a different FC", async () => {
    const { fc, link, toGround } = setup(true);
    link.start();
    await untilControl(link);
    fc.responding = false;
    await vi.advanceTimersByTimeAsync(600);
    fc.replies = { ...fc.replies, ...identificationReplies("INAV") };
    fc.responding = true;
    fc.emit(encodeMspV1("response", MspCommand.RC, new Uint8Array(0)));
    await vi.advanceTimersByTimeAsync(10);
    expect(link.identification).toMatchObject({ mode: "transparent", reason: "unsupported-firmware" });
    expect(link.mode).toBe("passthrough");
    const later = new Uint8Array([1]);
    fc.emit(later);
    expect(toGround).toEqual([later]);
  });

  it("returns to passthrough at once when the setting is turned off", async () => {
    const { fc, link, toGround } = setup(true);
    link.start();
    await untilControl(link);
    link.setFlightControlEnabled(false);
    expect(link.mode).toBe("passthrough");
    expect(link.flightControlEnabled).toBe(false);
    expect(link.sendRc([1500, 1500, 1500, 1500])).toBe(false);
    const requests = fc.requests.length;
    await vi.advanceTimersByTimeAsync(5_000);
    expect(fc.requests).toHaveLength(requests);
    const fromFc = new Uint8Array([1]);
    fc.emit(fromFc);
    expect(toGround).toEqual([fromFc]);
    link.writeFromGround(new Uint8Array([2]));
    expect(fc.writes.at(-1)).toEqual(new Uint8Array([2]));
  });

  it("drops an RC frame queued just before control ends", async () => {
    const { fc, link } = setup(true);
    link.start();
    await untilControl(link);
    let release: (() => void) | null = null;
    const write = fc.write.bind(fc);
    fc.write = (data) => {
      fc.write = write;
      return new Promise<void>((resolve) => {
        release = () => void write(data).then(resolve);
      });
    };
    await vi.advanceTimersByTimeAsync(20);
    link.sendRc([1500, 1500, 1500, 1500]);
    // Bypass stopControl()'s queue reset to reach the drain loop's own mode check.
    (link as unknown as { currentMode: string }).currentMode = "passthrough";
    release!();
    await vi.advanceTimersByTimeAsync(0);
    expect(fc.count(MspCommand.SET_RAW_RC)).toBe(0);
  });

  it("stops polling when stopped", async () => {
    const { fc, link } = setup(true);
    link.start();
    await untilControl(link);
    link.stop();
    const requests = fc.requests.length;
    await vi.advanceTimersByTimeAsync(1_000);
    expect(fc.requests).toHaveLength(requests);
    expect(link.healthy).toBe(false);
  });
});
