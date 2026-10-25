import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { parseFlightControlAirMessage, type FlightControlGroundMessage, type FlightControlState } from "@dronelink/core-transport";
import { FlightControlController, toFlightControlTelemetry, type FlightControlSessionPort } from "./FlightControlController.js";
import { createFlightControlSettingsStore } from "./FlightControlSettingsStore.js";
import type { FcLink, FcLinkEvent, FcTelemetry } from "./FcLink.js";

class FakeSession implements FlightControlSessionPort {
  flightControlChannelOpen = false;
  rejectedFlightControlMessages = 2;
  readonly sent: FlightControlState[] = [];
  handler: ((message: FlightControlGroundMessage) => void) | null = null;
  private channelListener: ((open: boolean) => void) | null = null;

  sendFlightControlState(state: FlightControlState): boolean {
    if (!this.flightControlChannelOpen) return false;
    this.sent.push(state);
    return true;
  }

  setFlightControlHandler(handler: ((message: FlightControlGroundMessage) => void) | null): void {
    this.handler = handler;
  }

  onFlightControlChannelChange(listener: (open: boolean) => void): () => void {
    this.channelListener = listener;
    return () => {
      this.channelListener = null;
    };
  }

  setOpen(open: boolean): void {
    this.flightControlChannelOpen = open;
    this.channelListener?.(open);
  }
}

function emptyTelemetry(): FcTelemetry {
  return { status: null, rc: null, rawGps: null, compGps: null, attitude: null, altitude: null, analog: null };
}

function fakeLink(overrides: Partial<FcLink> = {}) {
  let listener: ((event: FcLinkEvent) => void) | null = null;
  const link = {
    identification: { mode: "transparent", reason: "link-opened", identity: null },
    detectedType: "unknown",
    telemetry: emptyTelemetry(),
    setFlightControlEnabled: vi.fn(),
    onChange: vi.fn((l: (event: FcLinkEvent) => void) => {
      listener = l;
      return () => {
        listener = null;
      };
    }),
    ...overrides,
  } as unknown as FcLink;
  return { link, emit: (event: FcLinkEvent) => listener?.(event), subscribed: () => listener !== null };
}

function memoryStorage() {
  const values = new Map<string, string>();
  return { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => void values.set(key, value) };
}

function setup() {
  const session = new FakeSession();
  const settings = createFlightControlSettingsStore(memoryStorage());
  const controller = new FlightControlController({ session, settings });
  return { session, settings, controller };
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("FlightControlController", () => {
  it("reports a schema-valid transparent state with no FC link, periodically while the channel is open", async () => {
    const { session } = setup();
    expect(session.sent).toHaveLength(0);
    session.setOpen(true);
    expect(session.sent).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(session.sent).toHaveLength(6);
    const state = session.sent[0];
    expect(parseFlightControlAirMessage(JSON.parse(JSON.stringify(state)))).not.toBeNull();
    expect(state).toMatchObject({
      flightControlEnabled: false,
      link: { mode: "transparent", reason: "no-fc-link", detectedType: "silent" },
      fc: null,
      supervisor: { state: "IDLE", reason: null, lastAppliedSeq: null },
      telemetry: null,
      limits: { commandRateHz: 20, hoverThrottleUs: null },
      rejectedMessages: 2,
    });

    session.setOpen(false);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(session.sent).toHaveLength(6);
  });

  it("starts reporting at once when the channel is already open", () => {
    const session = new FakeSession();
    session.flightControlChannelOpen = true;
    new FlightControlController({ session, settings: createFlightControlSettingsStore(memoryStorage()) });
    expect(session.sent).toHaveLength(1);
  });

  it("applies the setting to the link and accepts it from the ground while idle", () => {
    const { session, settings, controller } = setup();
    const { link } = fakeLink();
    controller.attachLink(link);
    expect(link.setFlightControlEnabled).toHaveBeenLastCalledWith(false);

    session.handler!({ type: "fc-setting", flightControlEnabled: true });
    expect(settings.isEnabled()).toBe(true);
    expect(controller.flightControlEnabled).toBe(true);
    expect(link.setFlightControlEnabled).toHaveBeenLastCalledWith(true);

    expect(controller.setFlightControlEnabled(true)).toBe(true); // idempotent resend
    expect(link.setFlightControlEnabled).toHaveBeenCalledTimes(2);
    controller.setFlightControlEnabled(false);
    expect(settings.isEnabled()).toBe(false);
    session.handler!({ type: "fc-control", action: "unlock" }); // nothing to do without a supervisor
  });

  it("refuses a ground setting change outside IDLE/RELEASED", () => {
    const { controller, settings } = setup();
    vi.spyOn(controller, "supervisorState", "get").mockReturnValue("ACTIVE");
    expect(controller.setFlightControlEnabled(true, "ground")).toBe(false);
    expect(settings.isEnabled()).toBe(false);
    expect(controller.setFlightControlEnabled(true, "air")).toBe(true);
  });

  it("publishes on link events except telemetry, and detaches when the link closes", () => {
    const { session, controller } = setup();
    session.setOpen(true);
    const identity = { variant: "BTFL", version: "2026.6.2", apiVersion: "1.48", board: "Board", target: "T", build: "B", hoverThrottleUs: 1300, boxIds: [], rxMap: [] };
    const fake = fakeLink({ identification: { mode: "verified", reason: null, identity }, detectedType: "msp-v1" });
    const states: FlightControlState[] = [];
    const unsubscribe = controller.onStateChange((state) => states.push(state));
    controller.attachLink(fake.link);
    expect(states.at(-1)).toMatchObject({
      link: { mode: "verified", reason: null, detectedType: "msp-v1" },
      fc: { variant: "BTFL", version: "2026.6.2", apiVersion: "1.48", board: "Board" },
      limits: { hoverThrottleUs: 1300 },
    });
    const count = session.sent.length;
    fake.emit("telemetry");
    expect(session.sent).toHaveLength(count);
    fake.emit("mode");
    expect(session.sent).toHaveLength(count + 1);
    fake.emit("closed");
    expect(fake.subscribed()).toBe(false);
    expect(session.sent.at(-1)).toMatchObject({ link: { reason: "no-fc-link" }, fc: null });
    unsubscribe();
    fake.emit("mode");
    expect(states.at(-1)?.link.reason).toBe("no-fc-link");
  });

  it("stops reporting and receiving once disposed", async () => {
    const { session, controller } = setup();
    session.setOpen(true);
    controller.dispose();
    controller.dispose();
    expect(session.handler).toBeNull();
    const count = session.sent.length;
    await vi.advanceTimersByTimeAsync(1_000);
    controller.attachLink(null);
    expect(session.sent).toHaveLength(count);
  });
});

describe("toFlightControlTelemetry", () => {
  it("is null without a status and maps every field once one has arrived", () => {
    expect(toFlightControlTelemetry(emptyTelemetry())).toBeNull();
    const t = emptyTelemetry();
    t.status = {
      cycleTimeUs: 125, i2cErrors: 0, sensors: 0, flightModeFlags: new Uint8Array(4), pidProfile: 0, cpuLoad: 0,
      armingDisableFlags: 0, rebootRequired: false, armed: true, rxFailsafe: false, activeBoxes: new Set([0, 3, 11, 50, 27]), receivedAt: 1,
    };
    expect(toFlightControlTelemetry(t)).toEqual({
      armed: true,
      modes: ["ALTHOLD", "POSHOLD", "MSP_OVERRIDE", "FAILSAFE"],
      rxFailsafe: false,
      gps: { fix: false, numSat: 0, latitude: null, longitude: null },
      altitudeM: null, varioMS: null, headingDeg: null, rollDeg: null, pitchDeg: null, voltageV: null,
    });

    t.rawGps = { fix: false, numSat: 3, latitude: 59, longitude: 18, altitudeM: 0, groundSpeedCmS: 0, groundCourseDeg: 0, receivedAt: 1 };
    expect(toFlightControlTelemetry(t)?.gps).toEqual({ fix: false, numSat: 3, latitude: null, longitude: null });
    t.rawGps = { ...t.rawGps, fix: true };
    t.altitude = { altitudeM: 10, varioMS: 0.5, receivedAt: 1 };
    t.attitude = { rollDeg: 1, pitchDeg: 2, headingDeg: 90, receivedAt: 1 };
    t.analog = { voltageV: 16.2, mAhDrawn: 0, rssi: 0, currentA: 0, receivedAt: 1 };
    expect(toFlightControlTelemetry(t)).toMatchObject({
      gps: { fix: true, numSat: 3, latitude: 59, longitude: 18 },
      altitudeM: 10, varioMS: 0.5, headingDeg: 90, rollDeg: 1, pitchDeg: 2, voltageV: 16.2,
    });
  });
});
