import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MspCommand } from "@dronelink/fc-msp";
import type { FlightControlGroundMessage, FlightControlState } from "@dronelink/core-transport";
import { FcLink } from "./FcLink.js";
import { FlightControlController, type FlightControlSessionPort } from "./FlightControlController.js";
import { createFlightControlSettingsStore } from "./FlightControlSettingsStore.js";
import { FakeFc, identificationReplies, statusPayload, u16 } from "./testing/FakeFc.js";

class FakeSession implements FlightControlSessionPort {
  flightControlChannelOpen = true;
  rejectedFlightControlMessages = 0;
  readonly sent: FlightControlState[] = [];
  handler: ((message: FlightControlGroundMessage) => void) | null = null;
  channelListener: ((open: boolean) => void) | null = null;

  sendFlightControlState(state: FlightControlState): boolean {
    this.sent.push(state);
    return true;
  }

  setFlightControlHandler(handler: ((message: FlightControlGroundMessage) => void) | null): void {
    this.handler = handler;
  }

  onFlightControlChannelChange(listener: (open: boolean) => void): () => void {
    this.channelListener = listener;
    return () => undefined;
  }
}

function memoryStorage(enabled: boolean) {
  const values = new Map<string, string>([["dronelink.air.flightControlEnabled.v1", String(enabled)]]);
  return { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => void values.set(key, value) };
}

function setup(enabled = true) {
  const fc = new FakeFc();
  fc.echoOverride = true;
  fc.replies[MspCommand.STATUS_EX] = statusPayload(0b0111); // armed, holds on, handover switch off
  const session = new FakeSession();
  const controller = new FlightControlController({ session, settings: createFlightControlSettingsStore(memoryStorage(enabled)) });
  const link = new FcLink({ transport: fc, flightControlEnabled: controller.flightControlEnabled });
  const toGround: Uint8Array[] = [];
  link.onGroundBound((bytes) => toGround.push(bytes));
  controller.attachLink(link);
  link.start();
  let seq = 0;
  const ground = (message: FlightControlGroundMessage) => session.handler!(message);
  const command = (axes: { roll?: number; pitch?: number; yaw?: number; throttle?: number } = {}) =>
    ground({ type: "fc-command", seq: ++seq, sentAt: 0, roll: 0, pitch: 0, yaw: 0, throttle: 0, ...axes });
  /** Streams commands at 20 Hz for `ms`. */
  const stream = async (ms: number, axes: Parameters<typeof command>[0] = {}) => {
    for (let t = 0; t < ms; t += 50) {
      command(axes);
      await vi.advanceTimersByTimeAsync(50);
    }
  };
  /** The FC is identified with the switch off, then the SP flips the handover switch on. */
  const handOver = async () => {
    fc.replies[MspCommand.STATUS_EX] = statusPayload(0b0111);
    await vi.advanceTimersByTimeAsync(2_200);
    fc.replies[MspCommand.STATUS_EX] = statusPayload(0b1111);
    await vi.advanceTimersByTimeAsync(300);
  };
  return { fc, session, controller, link, toGround, ground, command, stream, handOver, last: () => session.sent.at(-1)! };
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("flight control end to end (FcLink + supervisor + controller, scripted Betaflight)", () => {
  it("hands over, unlocks, flies, and releases to the SP when the heartbeat stops", async () => {
    const { fc, controller, ground, stream, last, handOver } = setup();
    ground({ type: "fc-control", action: "unlock" }); // before verified: refused, nothing sent
    await handOver();
    expect(controller.supervisorState).toBe("HANDED_OVER");
    expect(fc.rcFrames).toEqual([]);

    ground({ type: "fc-control", action: "unlock" });
    expect(controller.supervisorState).toBe("ACTIVE");
    await stream(1_000, { roll: 1, throttle: -0.5 });
    expect(controller.supervisorState).toBe("ACTIVE"); // the override-mask check passed
    // Raw order via RX map [1, 0, 3, 2]: raw 0 = pitch, raw 1 = roll, raw 2 = throttle, raw 3 = yaw.
    expect(fc.rcFrames.at(-1)).toEqual([1500, 1650, 1300 - 75, 1500]);
    expect(fc.rcFrames.every((frame) => frame.length === 4)).toBe(true);
    expect(last()).toMatchObject({
      link: { mode: "verified" },
      supervisor: { state: "ACTIVE", reason: "unlocked" },
      telemetry: { armed: true, modes: ["ALTHOLD", "POSHOLD", "MSP_OVERRIDE"] },
      limits: { hoverThrottleUs: 1300 },
    });

    await vi.advanceTimersByTimeAsync(300);
    expect(controller.supervisorState).toBe("NEUTRAL");
    expect(fc.rcFrames.at(-1)).toEqual([1500, 1500, 1300, 1500]);
    await vi.advanceTimersByTimeAsync(700);
    expect(last().supervisor).toMatchObject({ state: "RELEASED", reason: "heartbeat-lost" });
    const frames = fc.rcFrames.length;
    await vi.advanceTimersByTimeAsync(3_000);
    expect(fc.rcFrames).toHaveLength(frames);
  });

  it("aborts to a centered hover and keeps it while the heartbeat lives", async () => {
    const { fc, controller, ground, stream, handOver } = setup();
    await handOver();
    ground({ type: "fc-control", action: "unlock" });
    await stream(500, { pitch: 1 });
    ground({ type: "fc-control", action: "abort" });
    const from = fc.rcFrames.length;
    await stream(2_000, { pitch: 1, yaw: 1 });
    expect(controller.supervisorState).toBe("ABORTED");
    expect(fc.rcFrames.slice(from).every((frame) => frame.join() === "1500,1500,1300,1500")).toBe(true);
  });

  it("stops sending in the same tick the FC link is lost", async () => {
    const { fc, controller, ground, stream, handOver } = setup();
    await handOver();
    ground({ type: "fc-control", action: "unlock" });
    await stream(200);
    fc.responding = false;
    await stream(600);
    expect(controller.supervisorState).toBe("RELEASED");
    const frames = fc.rcFrames.length;
    await stream(1_000);
    expect(fc.rcFrames).toHaveLength(frames);
  });

  it("releases and returns the link to passthrough when the setting is turned off", async () => {
    const { fc, controller, link, toGround, ground, stream, handOver } = setup();
    await handOver();
    ground({ type: "fc-control", action: "unlock" });
    await stream(200);
    controller.setFlightControlEnabled(false, "air");
    expect(controller.supervisorState).toBe("IDLE");
    expect(link.mode).toBe("passthrough");
    const frames = fc.rcFrames.length;
    await stream(1_000);
    expect(fc.rcFrames).toHaveLength(frames);
    const bytes = new Uint8Array([1, 2]);
    fc.emit(bytes);
    expect(toGround).toEqual([bytes]);
  });

  it("refuses the setting from the ground while flying", async () => {
    const { controller, ground, stream, handOver } = setup();
    await handOver();
    ground({ type: "fc-control", action: "unlock" });
    ground({ type: "fc-setting", flightControlEnabled: false });
    await stream(100);
    expect(controller.flightControlEnabled).toBe(true);
    expect(controller.supervisorState).toBe("ACTIVE");
  });

  it("releases when the page is hidden or the channel closes", async () => {
    const { session, controller, ground, stream, handOver } = setup();
    await handOver();
    ground({ type: "fc-control", action: "unlock" });
    await stream(100);
    controller.setPageVisible(false);
    expect(controller.supervisorState).toBe("RELEASED");

    session.channelListener!(false);
    controller.setPageVisible(true);
    expect(session.sent.at(-1)?.supervisor).toMatchObject({ state: "RELEASED", reason: "page-hidden" });
  });

  it("releases when the SP flips the handover switch back", async () => {
    const { fc, controller, ground, stream, handOver } = setup();
    await handOver();
    ground({ type: "fc-control", action: "unlock" });
    await stream(200);
    fc.replies[MspCommand.STATUS_EX] = statusPayload(0b0111);
    await stream(300);
    expect(controller.supervisorState).toBe("IDLE"); // released, then the switch is seen off
    // IDLE then reports what blocks a new handover: the switch is off.
    expect(controller.buildState().supervisor.reason).toBe("sp-took-control");
  });

  it("releases and makes the link transparent when MSP_RC doesn't follow the override", async () => {
    const { fc, link, controller, ground, stream, handOver } = setup();
    fc.echoOverride = false;
    fc.replies[MspCommand.RC] = new Uint8Array([...u16(1500), ...u16(1500), ...u16(1510), ...u16(1300), ...u16(1900)]);
    await handOver();
    ground({ type: "fc-control", action: "unlock" });
    expect(controller.supervisorState).toBe("ACTIVE");
    await stream(1_100);
    expect(controller.supervisorState).not.toBe("ACTIVE");
    expect(link.mode).toBe("passthrough");
    expect(link.identification).toMatchObject({ mode: "transparent", reason: "override-mask-mismatch" });
  });

  it("never writes MSP_SET_RAW_RC to an FC that fails identification", async () => {
    const { fc, controller, ground, stream, handOver } = setup();
    fc.replies = { ...fc.replies, ...identificationReplies("INAV") };
    await handOver();
    ground({ type: "fc-control", action: "unlock" });
    await stream(1_000, { roll: 1 });
    expect(controller.supervisorState).toBe("IDLE");
    expect(fc.count(MspCommand.SET_RAW_RC)).toBe(0);
  });

  it("re-locks when the FC link is reopened", async () => {
    const { fc, controller, link, ground, stream, handOver } = setup();
    await handOver();
    ground({ type: "fc-control", action: "unlock" });
    await stream(100);
    fc.emit(new Uint8Array(0)); // transport closed
    expect(controller.supervisorState).toBe("RELEASED");
    expect(link.mode).toBe("passthrough");

    const next = new FcLink({ transport: fc, flightControlEnabled: true });
    controller.attachLink(next);
    next.start();
    expect(controller.supervisorState).toBe("IDLE");
    await vi.advanceTimersByTimeAsync(2_500);
    // The switch was still on across the reconnect: that is not a fresh handover.
    expect(controller.buildState().supervisor).toMatchObject({ state: "IDLE", reason: "awaiting-fresh-handover" });
    await handOver();
    expect(controller.supervisorState).toBe("HANDED_OVER");
  });
});
