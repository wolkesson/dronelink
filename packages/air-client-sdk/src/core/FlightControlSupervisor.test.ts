import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FlightControlCommand, SupervisorState } from "@dronelink/core-transport";
import {
  FlightControlSupervisor,
  isStickRxMap,
  type SupervisorConfig,
  type SupervisorFcState,
  type SupervisorInputs,
  type SupervisorSnapshot,
} from "./FlightControlSupervisor.js";

const HOVER = 1300;
/** Raw channel per function: roll on raw 1, pitch on raw 0, yaw on raw 3, throttle on raw 2. */
const RX_MAP = [1, 0, 3, 2, 4, 5];

function fcState(overrides: Partial<SupervisorFcState> = {}): SupervisorFcState {
  return {
    receivedAt: Date.now(),
    armed: true,
    posHold: true,
    mspOverride: true,
    rxFailsafe: false,
    gpsFix: true,
    numSat: 12,
    rc: { channels: [1500, 1500, 1500, HOVER, 1900], receivedAt: Date.now() },
    ...overrides,
  };
}

function goodInputs(): SupervisorInputs {
  return {
    flightControlEnabled: true,
    identity: { hoverThrottleUs: HOVER, rxMap: RX_MAP },
    fcLinkHealthy: true,
    channelOpen: true,
    pageVisible: true,
    fc: fcState(),
  };
}

/** Functions R, P, Y, T back out of a raw frame. */
function toFunctions(raw: number[]): number[] {
  return [raw[RX_MAP[0]], raw[RX_MAP[1]], raw[RX_MAP[2]], raw[RX_MAP[3]]];
}

const CENTER_FRAME = [1500, 1500, 1500, HOVER];

function setup(config: Partial<SupervisorConfig> = {}) {
  const frames: number[][] = [];
  const snapshots: SupervisorSnapshot[] = [];
  const supervisor = new FlightControlSupervisor({
    sendRc: (raw) => frames.push(raw),
    config: { maxStatusAgeMs: 1e9, maskCheckTimeoutMs: 1e9, ...config },
  });
  supervisor.onChange((snapshot) => snapshots.push(snapshot));
  let seq = 0;
  const command = (axes: Partial<FlightControlCommand> = {}) =>
    supervisor.handleCommand({ type: "fc-command", seq: ++seq, sentAt: 0, roll: 0, pitch: 0, yaw: 0, throttle: 0, ...axes });
  return { supervisor, frames, snapshots, command, functions: () => frames.map(toFunctions) };
}

type Setup = ReturnType<typeof setup>;

/** The SP flips the handover switch on while the supervisor watches. */
function handOver(s: Setup): void {
  s.supervisor.update({ ...goodInputs(), fc: fcState({ mspOverride: false }) });
  s.supervisor.update(goodInputs());
  expect(s.supervisor.state).toBe("HANDED_OVER");
}

function activate(s: Setup): void {
  handOver(s);
  s.supervisor.handleControl("unlock");
  expect(s.supervisor.state).toBe("ACTIVE");
}

/** Drives the supervisor into `state` with a live heartbeat. */
function reach(s: Setup, state: SupervisorState): void {
  if (state === "IDLE") return;
  if (state === "HANDED_OVER") return handOver(s);
  activate(s);
  if (state === "NEUTRAL") {
    vi.advanceTimersByTime(300);
  } else if (state === "ABORTED") {
    s.supervisor.handleControl("abort");
  } else if (state === "RELEASED") {
    s.supervisor.handleControl("release");
  }
  expect(s.supervisor.state).toBe(state);
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

const PRECONDITION_LOSSES: [string, Partial<SupervisorInputs> | (() => Partial<SupervisorInputs>)][] = [
  ["setting-disabled", { flightControlEnabled: false }],
  ["not-verified", { identity: null }],
  ["not-verified", { identity: { hoverThrottleUs: HOVER, rxMap: [0, 1, 2, 4] } }],
  ["fc-link-lost", { fcLinkHealthy: false }],
  ["channel-closed", { channelOpen: false }],
  ["page-hidden", { pageVisible: false }],
  ["telemetry-stale", { fc: null }],
  ["sp-took-control", () => ({ fc: fcState({ mspOverride: false }) })],
  ["pos-hold-lost", () => ({ fc: fcState({ posHold: false }) })],
  ["disarmed", () => ({ fc: fcState({ armed: false }) })],
  ["rx-failsafe", () => ({ fc: fcState({ rxFailsafe: true }) })],
  ["gps-lost", () => ({ fc: fcState({ gpsFix: false }) })],
  ["gps-lost", () => ({ fc: fcState({ numSat: 7 }) })],
];

describe("FlightControlSupervisor: handover", () => {
  it("starts IDLE and hands over (locked, sending nothing) once every precondition holds", () => {
    const s = setup();
    expect(s.supervisor.snapshot).toEqual({ state: "IDLE", reason: null, lastAppliedSeq: null });
    handOver(s);
    expect(s.supervisor.snapshot).toEqual({ state: "HANDED_OVER", reason: "handover", lastAppliedSeq: null });
    vi.advanceTimersByTime(5_000);
    expect(s.frames).toEqual([]);
  });

  it("needs the switch flipped on while it watches: one already on doesn't hand over", () => {
    const s = setup({ maxStatusAgeMs: 500 });
    s.supervisor.update(goodInputs());
    expect(s.supervisor.snapshot).toMatchObject({ state: "IDLE", reason: "awaiting-fresh-handover" });
    const notified = s.snapshots.length;
    s.supervisor.update({ fc: fcState() });
    expect(s.snapshots).toHaveLength(notified);
    // A stale "switch off" reading doesn't count as seeing it off.
    s.supervisor.update({ fc: fcState({ mspOverride: false, receivedAt: Date.now() - 600 }) });
    s.supervisor.update({ fc: fcState() });
    expect(s.supervisor.state).toBe("IDLE");
    s.supervisor.update({ fc: fcState({ mspOverride: false }) });
    s.supervisor.update({ fc: fcState() });
    expect(s.supervisor.snapshot).toMatchObject({ state: "HANDED_OVER", reason: "handover" });
  });

  it("needs a fresh switch cycle after a reset (FC link reopened) and after a setting toggle", () => {
    const s = setup();
    activate(s);
    s.supervisor.reset("fc-link-opened");
    s.supervisor.update(goodInputs());
    expect(s.supervisor.snapshot).toMatchObject({ state: "IDLE", reason: "awaiting-fresh-handover" });

    const t = setup();
    reach(t, "ACTIVE");
    t.supervisor.update({ flightControlEnabled: false });
    t.supervisor.update({ flightControlEnabled: true });
    expect(t.supervisor.snapshot).toMatchObject({ state: "RELEASED", reason: "setting-disabled" });
  });

  it.each(PRECONDITION_LOSSES)("stays IDLE without %s, and says so", (reason, loss) => {
    const s = setup();
    s.supervisor.update({ ...goodInputs(), ...(typeof loss === "function" ? loss() : loss) });
    expect(s.supervisor.snapshot).toMatchObject({ state: "IDLE", reason });
    const notified = s.snapshots.length;
    s.supervisor.update({});
    expect(s.snapshots).toHaveLength(notified); // an unchanged reason isn't re-announced
  });

  it("drops and counts commands while locked, and ignores abort there", () => {
    const s = setup();
    handOver(s);
    s.command({ roll: 1 });
    s.supervisor.handleControl("abort");
    expect(s.supervisor.state).toBe("HANDED_OVER");
    expect(s.supervisor.droppedCommands).toBe(1);
    expect(s.frames).toEqual([]);
  });

  it("unlocks into ACTIVE and sends a centered frame at once", () => {
    const s = setup();
    activate(s);
    expect(s.supervisor.snapshot.reason).toBe("unlocked");
    expect(s.frames).toHaveLength(1);
    expect(s.functions()[0]).toEqual(CENTER_FRAME);
    expect(s.frames[0]).toHaveLength(4);
    expect(s.supervisor.rcFramesSent).toBe(1);
  });

  it.each<[string, Partial<SupervisorFcState>]>([
    ["no-rc", { rc: null }],
    ["no-rc", { rc: { channels: [1500, 1500, 1500], receivedAt: 0 } }],
    ["sticks-not-neutral", { rc: { channels: [1526, 1500, 1500, HOVER], receivedAt: 0 } }],
    ["sticks-not-neutral", { rc: { channels: [1500, 1474, 1500, HOVER], receivedAt: 0 } }],
    ["sticks-not-neutral", { rc: { channels: [1500, 1500, 1530, HOVER], receivedAt: 0 } }],
    ["sticks-not-neutral", { rc: { channels: [1500, 1500, 1500, HOVER + 51], receivedAt: 0 } }],
  ])("refuses unlock with %s", (reason, fc) => {
    const s = setup();
    handOver(s);
    const rc = fc.rc === null ? null : fc.rc ? { ...fc.rc, receivedAt: Date.now() } : undefined;
    s.supervisor.update({ fc: fcState(rc === undefined ? {} : { rc }) });
    s.supervisor.handleControl("unlock");
    expect(s.supervisor.snapshot).toMatchObject({ state: "HANDED_OVER", reason: `unlock-refused:${reason}` });
    expect(s.supervisor.refusedUnlocks).toBe(1);
    expect(s.frames).toEqual([]);
  });

  it("refuses unlock on stale stick data and accepts sticks just inside the deadbands", () => {
    const s = setup({ maxStatusAgeMs: 500 });
    handOver(s);
    vi.advanceTimersByTime(400);
    s.supervisor.update({ fc: { ...fcState(), rc: { channels: [1500, 1500, 1500, HOVER], receivedAt: Date.now() - 501 } } });
    s.supervisor.handleControl("unlock");
    expect(s.supervisor.snapshot.reason).toBe("unlock-refused:no-rc");
    s.supervisor.update({ fc: fcState({ rc: { channels: [1525, 1475, 1525, HOVER - 50], receivedAt: Date.now() } }) });
    s.supervisor.handleControl("unlock");
    expect(s.supervisor.state).toBe("ACTIVE");
  });

  it.each<SupervisorState>(["IDLE", "ACTIVE", "NEUTRAL", "RELEASED"])("refuses unlock in %s", (state) => {
    const s = setup();
    reach(s, state);
    s.supervisor.handleControl("unlock");
    expect(s.supervisor.snapshot).toMatchObject({ state, reason: "unlock-refused:not-handed-over" });
  });
});

describe("FlightControlSupervisor: ACTIVE", () => {
  it("streams frames at 20 Hz, mapped to raw channel order around the hover throttle", () => {
    const s = setup();
    activate(s);
    for (let i = 0; i < 20; i++) {
      s.command({ roll: 1, pitch: -1, yaw: 1, throttle: 1 });
      vi.advanceTimersByTime(50);
    }
    expect(s.frames).toHaveLength(21); // the unlock frame plus 20 Hz for a second
    expect(s.frames.at(-1)).toEqual([1350, 1650, HOVER + 150, 1650]); // raw order via RX_MAP [1, 0, 3, 2]
  });

  it("clamps each axis to its deflection limit and slews across the full range in 500 ms", () => {
    const s = setup({ maxDeflectionUs: { roll: 150, pitch: 100, yaw: 80, throttle: 120 } });
    activate(s);
    const ticks: number[][] = [];
    for (let i = 0; i < 12; i++) {
      s.command({ roll: 1, pitch: -1, yaw: 0.5, throttle: -1 });
      vi.advanceTimersByTime(50);
      ticks.push(s.functions().at(-1)!);
    }
    // 50 ms of slew is a tenth of the range: roll 150 µs -> 30 µs per tick.
    expect(ticks[0]).toEqual([1530, 1480, 1516, HOVER - 24]);
    expect(ticks[4]).toEqual([1650, 1400, 1540, HOVER - 120]);
    expect(ticks[11]).toEqual([1650, 1400, 1540, HOVER - 120]);
    for (const frame of s.functions()) {
      expect(Math.abs(frame[0] - 1500)).toBeLessThanOrEqual(150);
      expect(Math.abs(frame[3] - HOVER)).toBeLessThanOrEqual(120);
    }
  });

  it("limits the slew after a stalled tick to two periods", () => {
    const s = setup();
    activate(s);
    s.command({ roll: 1 });
    (s.supervisor as unknown as { lastTickAt: number }).lastTickAt -= 10_000;
    vi.advanceTimersByTime(50);
    expect(s.functions().at(-1)![0]).toBe(1500 + 60);
  });

  it("drops commands whose seq isn't newer and reports the last applied seq", () => {
    const s = setup();
    activate(s);
    s.supervisor.handleCommand({ type: "fc-command", seq: 5, sentAt: 0, roll: 0, pitch: 0, yaw: 0, throttle: 0 });
    s.supervisor.handleCommand({ type: "fc-command", seq: 5, sentAt: 0, roll: 1, pitch: 0, yaw: 0, throttle: 0 });
    s.supervisor.handleCommand({ type: "fc-command", seq: 3, sentAt: 0, roll: 1, pitch: 0, yaw: 0, throttle: 0 });
    expect(s.supervisor.droppedCommands).toBe(2);
    expect(s.supervisor.snapshot.lastAppliedSeq).toBe(5);
    vi.advanceTimersByTime(50);
    expect(s.functions().at(-1)![0]).toBe(1500);
  });

  it("restarts the seq on a new handover and on a reopened channel", () => {
    const s = setup();
    activate(s);
    s.supervisor.handleCommand({ type: "fc-command", seq: 100, sentAt: 0, roll: 0, pitch: 0, yaw: 0, throttle: 0 });
    s.supervisor.update({ channelOpen: false });
    s.supervisor.update({ fc: fcState({ mspOverride: false }) });
    s.supervisor.update({ channelOpen: true, fc: fcState() });
    s.supervisor.handleControl("unlock");
    s.supervisor.handleCommand({ type: "fc-command", seq: 1, sentAt: 0, roll: 0, pitch: 0, yaw: 0, throttle: 0 });
    expect(s.supervisor.snapshot.lastAppliedSeq).toBe(1);
  });

  it("goes NEUTRAL (all sticks center at once) after 250 ms without a command, and back on a fresh one", () => {
    const s = setup();
    activate(s);
    for (let i = 0; i < 10; i++) {
      s.command({ roll: 1, throttle: 1 });
      vi.advanceTimersByTime(50);
    }
    expect(s.functions().at(-1)).toEqual([1650, 1500, 1500, HOVER + 150]);
    const before = s.frames.length;
    vi.advanceTimersByTime(250);
    expect(s.supervisor.snapshot).toMatchObject({ state: "NEUTRAL", reason: "heartbeat-lost" });
    const afterNeutral = s.functions().slice(before);
    const neutralAt = afterNeutral.findIndex((frame) => frame.join() === CENTER_FRAME.join());
    expect(afterNeutral.slice(neutralAt).every((frame) => frame.join() === CENTER_FRAME.join())).toBe(true);
    vi.advanceTimersByTime(500);
    expect(s.functions().at(-1)).toEqual(CENTER_FRAME);

    s.command({ roll: 1 });
    expect(s.supervisor.snapshot).toMatchObject({ state: "ACTIVE", reason: "heartbeat-restored" });
    expect(s.functions().at(-1)![0]).toBe(1500); // slews from center again, never jumps back
  });

  it("goes NEUTRAL and RELEASED at the exact deadlines, not on the next 20 Hz tick", () => {
    const s = setup();
    activate(s);
    vi.advanceTimersByTime(10); // off the tick grid
    s.command({ roll: 1 });
    vi.advanceTimersByTime(249);
    expect(s.supervisor.state).toBe("ACTIVE");
    vi.advanceTimersByTime(1);
    expect(s.supervisor.snapshot).toMatchObject({ state: "NEUTRAL", reason: "heartbeat-lost" });
    expect(s.functions().at(-1)).toEqual(CENTER_FRAME);
    vi.advanceTimersByTime(749);
    expect(s.supervisor.state).toBe("NEUTRAL");
    vi.advanceTimersByTime(1);
    expect(s.supervisor.snapshot).toMatchObject({ state: "RELEASED", reason: "heartbeat-lost" });
  });

  it("re-arms the watchdog when the deadline finds the heartbeat already restored", () => {
    const s = setup();
    activate(s);
    vi.advanceTimersByTime(10);
    s.command();
    // A command lands just before the deadline but after the timer was armed for it.
    (s.supervisor as unknown as { lastCommandAt: number }).lastCommandAt += 100;
    vi.advanceTimersByTime(250);
    expect(s.supervisor.state).toBe("ACTIVE");
    vi.advanceTimersByTime(100);
    expect(s.supervisor.state).toBe("NEUTRAL");
  });

  it("lets a precondition loss win at the deadline", () => {
    const s = setup({ maxStatusAgeMs: 255 });
    activate(s);
    vi.advanceTimersByTime(10);
    s.command();
    vi.advanceTimersByTime(250); // telemetry is now 260 ms old: stale
    expect(s.supervisor.snapshot).toMatchObject({ state: "RELEASED", reason: "telemetry-stale" });
  });

  describe("after the air itself stalls (frozen tab) longer than Betaflight's stale window", () => {
    /** Time passes without any timer running, as in a paused page. */
    const freeze = (ms: number) => vi.setSystemTime(Date.now() + ms);

    it("releases on the first queued command instead of applying it", () => {
      const s = setup();
      activate(s);
      s.command({ roll: 1 });
      vi.advanceTimersByTime(50);
      const sent = s.frames.length;
      freeze(3_000);
      s.command({ pitch: 1 });
      expect(s.supervisor.snapshot).toMatchObject({ state: "RELEASED", reason: "air-stalled" });
      vi.advanceTimersByTime(1_000);
      expect(s.frames).toHaveLength(sent);
      expect(s.supervisor.droppedCommands).toBe(1);
    });

    it("releases on the first tick", () => {
      const s = setup();
      reach(s, "ABORTED");
      const sent = s.frames.length;
      freeze(400);
      vi.advanceTimersByTime(50);
      expect(s.supervisor.snapshot).toMatchObject({ state: "RELEASED", reason: "air-stalled" });
      expect(s.frames).toHaveLength(sent);
    });

    it("releases when the watchdog fires first", () => {
      const s = setup();
      activate(s);
      vi.advanceTimersByTime(10);
      s.command(); // watchdog due at 260, between the ticks at 250 and 300
      vi.advanceTimersByTime(240); // the tick at 250 sends a frame
      const sent = s.frames.length;
      freeze(301);
      vi.advanceTimersByTime(10); // the watchdog fires first
      expect(s.supervisor.snapshot).toMatchObject({ state: "RELEASED", reason: "air-stalled" });
      expect(s.frames).toHaveLength(sent);
    });

    it("tolerates ordinary jitter below the window", () => {
      const s = setup();
      activate(s);
      s.command({ roll: 1 });
      freeze(250);
      s.command({ roll: 1 });
      expect(s.supervisor.state).toBe("ACTIVE");
    });
  });

  it("releases after 1 s without a command and stops sending", () => {
    const s = setup();
    activate(s);
    vi.advanceTimersByTime(999);
    expect(s.supervisor.state).toBe("NEUTRAL");
    vi.advanceTimersByTime(1);
    expect(s.supervisor.snapshot).toMatchObject({ state: "RELEASED", reason: "heartbeat-lost" });
    const sent = s.frames.length;
    vi.advanceTimersByTime(5_000);
    expect(s.frames).toHaveLength(sent);
  });
});

describe("FlightControlSupervisor: ABORT and release", () => {
  it.each<SupervisorState>(["ACTIVE", "NEUTRAL"])("aborts from %s: center at once, commands ignored, heartbeat keeps the hover", (state) => {
    const s = setup();
    reach(s, state);
    s.command({ roll: 1, pitch: 1 });
    vi.advanceTimersByTime(100);
    const before = s.frames.length;
    s.supervisor.handleControl("abort");
    expect(s.supervisor.snapshot).toMatchObject({ state: "ABORTED", reason: "abort" });
    expect(s.frames).toHaveLength(before + 1);
    for (let i = 0; i < 40; i++) {
      s.command({ roll: 1, yaw: -1, throttle: 1 });
      vi.advanceTimersByTime(50);
    }
    expect(s.supervisor.state).toBe("ABORTED");
    expect(s.functions().slice(before).every((frame) => frame.join() === CENTER_FRAME.join())).toBe(true);
    s.supervisor.handleControl("abort");
    expect(s.supervisor.state).toBe("ABORTED");
  });

  it("releases an aborted craft once its heartbeat stops", () => {
    const s = setup();
    reach(s, "ABORTED");
    vi.advanceTimersByTime(999);
    expect(s.supervisor.state).toBe("ABORTED");
    vi.advanceTimersByTime(1);
    expect(s.supervisor.snapshot).toMatchObject({ state: "RELEASED", reason: "heartbeat-lost" });
  });

  it("needs a new unlock after ABORT and resumes from center", () => {
    const s = setup();
    reach(s, "ABORTED");
    s.supervisor.handleControl("unlock");
    expect(s.supervisor.snapshot).toMatchObject({ state: "ACTIVE", reason: "unlocked" });
    expect(s.functions().at(-1)).toEqual(CENTER_FRAME);
    s.command({ pitch: 1 });
    vi.advanceTimersByTime(50);
    expect(s.functions().at(-1)![1]).toBe(1530);
  });

  it.each<SupervisorState>(["IDLE", "RELEASED"])("ignores abort in %s", (state) => {
    const s = setup();
    reach(s, state);
    s.supervisor.handleControl("abort");
    expect(s.supervisor.state).toBe(state);
  });

  it.each<SupervisorState>(["HANDED_OVER", "ACTIVE", "NEUTRAL", "ABORTED"])("releases on ground release from %s", (state) => {
    const s = setup();
    reach(s, state);
    s.supervisor.handleControl("release");
    expect(s.supervisor.snapshot).toMatchObject({ state: "RELEASED", reason: "ground-release" });
    const sent = s.frames.length;
    vi.advanceTimersByTime(2_000);
    expect(s.frames).toHaveLength(sent);
  });

  it("ignores release in IDLE", () => {
    const s = setup();
    s.supervisor.handleControl("release");
    expect(s.supervisor.state).toBe("IDLE");
  });
});

describe("FlightControlSupervisor: preconditions (fail-safe matrix)", () => {
  const handedOverStates: SupervisorState[] = ["HANDED_OVER", "ACTIVE", "NEUTRAL", "ABORTED"];
  const cases = handedOverStates.flatMap((state) => PRECONDITION_LOSSES.map(([reason, loss]) => [state, reason, loss] as const));

  it.each(cases)("%s -> RELEASED on %s, in the same call, and stops sending", (state, reason, loss) => {
    const s = setup();
    reach(s, state);
    const sent = s.frames.length;
    s.supervisor.update(typeof loss === "function" ? loss() : loss);
    expect(s.supervisor.snapshot.state).toBe("RELEASED");
    expect(s.supervisor.snapshot.reason).toBe(reason);
    vi.advanceTimersByTime(2_000);
    expect(s.frames).toHaveLength(sent);
  });

  it("treats FC status older than the limit as lost telemetry, checked on every tick", () => {
    const s = setup({ maxStatusAgeMs: 500 });
    activate(s);
    for (let i = 0; i < 9; i++) {
      s.command();
      vi.advanceTimersByTime(50);
    }
    expect(s.supervisor.state).toBe("ACTIVE");
    s.command();
    vi.advanceTimersByTime(100);
    expect(s.supervisor.snapshot).toMatchObject({ state: "RELEASED", reason: "telemetry-stale" });
  });

  it("needs the SP's switch seen off before handing over again", () => {
    const s = setup();
    reach(s, "RELEASED");
    s.supervisor.update(goodInputs());
    expect(s.supervisor.state).toBe("RELEASED");
    s.supervisor.update({ fc: null });
    expect(s.supervisor.state).toBe("RELEASED");
    s.supervisor.update({ fc: fcState({ mspOverride: false }) });
    // Still RELEASED with the reason it released for, so the GUI can keep saying why.
    expect(s.supervisor.snapshot).toMatchObject({ state: "RELEASED", reason: "ground-release" });
    s.supervisor.update({ fc: fcState() });
    expect(s.supervisor.snapshot).toMatchObject({ state: "HANDED_OVER", reason: "handover" });
    s.supervisor.handleControl("unlock");
    expect(s.supervisor.state).toBe("ACTIVE");
  });

  it("stays RELEASED with the setting turned off, and needs a fresh handover once it is back on", () => {
    const s = setup();
    reach(s, "RELEASED");
    s.supervisor.update({ flightControlEnabled: false });
    expect(s.supervisor.snapshot).toMatchObject({ state: "RELEASED", reason: "ground-release" });
    s.supervisor.update({ flightControlEnabled: true });
    expect(s.supervisor.state).toBe("RELEASED");
    s.supervisor.update({ fc: fcState({ mspOverride: false }) });
    s.supervisor.update({ fc: fcState() });
    expect(s.supervisor.state).toBe("HANDED_OVER");
  });
});

describe("FlightControlSupervisor: override mask check", () => {
  it("passes once MSP_RC follows a sent frame", () => {
    const s = setup({ maskCheckTimeoutMs: 1_000 });
    activate(s);
    vi.advanceTimersByTime(100);
    s.supervisor.update({ fc: fcState({ rc: { channels: [1500, 1500, 1501, HOVER], receivedAt: Date.now() } }) });
    for (let i = 0; i < 40; i++) {
      s.command({ roll: 1 });
      vi.advanceTimersByTime(50);
    }
    expect(s.supervisor.state).toBe("ACTIVE");
  });

  it("releases when the sticks don't follow the override within the timeout", () => {
    const s = setup({ maskCheckTimeoutMs: 1_000 });
    activate(s);
    for (let i = 0; i < 19; i++) {
      s.command({ roll: 1 });
      vi.advanceTimersByTime(50);
      // The SP's own (non-overridden) roll stick keeps showing up.
      s.supervisor.update({ fc: fcState({ rc: { channels: [1440, 1500, 1500, HOVER], receivedAt: Date.now() } }) });
    }
    expect(s.supervisor.state).toBe("ACTIVE");
    s.command({ roll: 1 });
    vi.advanceTimersByTime(50);
    expect(s.supervisor.snapshot).toMatchObject({ state: "RELEASED", reason: "override-mask-mismatch" });
  });

  it("ignores MSP_RC samples from before the first frame", () => {
    const s = setup({ maskCheckTimeoutMs: 1_000 });
    handOver(s);
    s.supervisor.handleControl("unlock");
    s.supervisor.update({ fc: fcState({ rc: { channels: [1500, 1500, 1500, HOVER], receivedAt: Date.now() - 1 } }) });
    for (let i = 0; i < 20; i++) {
      s.command();
      vi.advanceTimersByTime(50);
    }
    expect(s.supervisor.snapshot.reason).toBe("override-mask-mismatch");
  });

  it("ignores a short MSP_RC reply", () => {
    const s = setup({ maskCheckTimeoutMs: 1_000 });
    activate(s);
    vi.advanceTimersByTime(50);
    s.supervisor.update({ fc: fcState({ rc: { channels: [1500, 1500, 1500], receivedAt: Date.now() } }) });
    for (let i = 0; i < 20; i++) {
      s.command();
      vi.advanceTimersByTime(50);
    }
    expect(s.supervisor.snapshot.reason).toBe("override-mask-mismatch");
  });
});

describe("FlightControlSupervisor: lifecycle", () => {
  it("resets to IDLE and stops sending", () => {
    const s = setup();
    activate(s);
    s.supervisor.reset("fc-link-opened");
    expect(s.supervisor.snapshot).toMatchObject({ state: "IDLE", reason: "fc-link-opened" });
    const sent = s.frames.length;
    vi.advanceTimersByTime(1_000);
    expect(s.frames).toHaveLength(sent);
    s.supervisor.update({ fcLinkHealthy: true, fc: fcState() });
    expect(s.supervisor.state).toBe("IDLE"); // the identity was cleared with the link
  });

  it("does nothing once disposed", () => {
    const s = setup();
    activate(s);
    s.supervisor.dispose();
    s.supervisor.dispose();
    const sent = s.frames.length;
    s.supervisor.update(goodInputs());
    s.supervisor.handleControl("unlock");
    s.command();
    s.supervisor.reset("x");
    vi.advanceTimersByTime(1_000);
    expect(s.frames).toHaveLength(sent);
    expect(s.supervisor.snapshot).toMatchObject({ state: "RELEASED", reason: "disposed" });
  });

  it("stops notifying an unsubscribed listener", () => {
    const s = setup();
    const listener = vi.fn();
    const unsubscribe = s.supervisor.onChange(listener);
    handOver(s);
    unsubscribe();
    s.supervisor.handleControl("release");
    expect(listener).toHaveBeenCalledTimes(2); // the IDLE reason (switch off), then the handover
    expect(s.snapshots.map((snapshot) => snapshot.state)).toEqual(["IDLE", "HANDED_OVER", "RELEASED"]);
  });

  it("doesn't send the entry frame when a listener releases during the transition", () => {
    const s = setup();
    handOver(s);
    s.supervisor.onChange((snapshot) => {
      if (snapshot.state === "ACTIVE") s.supervisor.handleControl("release");
    });
    s.supervisor.handleControl("unlock");
    expect(s.supervisor.state).toBe("RELEASED");
    expect(s.frames).toEqual([]);
  });

  it("uses the system clock by default", () => {
    const supervisor = new FlightControlSupervisor({ sendRc: () => undefined });
    expect(supervisor.state).toBe("IDLE");
  });
});

describe("isStickRxMap", () => {
  it("accepts any permutation of raw channels 0-3 for the sticks only", () => {
    expect(isStickRxMap([3, 2, 1, 0, 4])).toBe(true);
    expect(isStickRxMap([0, 1, 2, 4, 3])).toBe(false);
    expect(isStickRxMap([0, 1, 1, 2])).toBe(false);
    expect(isStickRxMap([0, 1, 2])).toBe(false);
  });
});
