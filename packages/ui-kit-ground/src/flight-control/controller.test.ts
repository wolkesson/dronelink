import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FlightControlCommand, FlightControlGroundMessage, FlightControlState } from "@dronelink/core-transport";
import { FlightControlGui, type FlightControlGuiView } from "./controller.js";
import { fcState } from "./test-state.test-util.js";

function setup() {
  const sent: FlightControlGroundMessage[] = [];
  const gui = new FlightControlGui({ send: (message) => sent.push(message) });
  const views: FlightControlGuiView[] = [];
  gui.onChange((view) => views.push(view));
  gui.setSocketOpen(true);
  gui.setRtt(80);
  gui.handleMessage({ type: "fc-channel", open: true });
  /** Delivers an air fc-state, as the 5 Hz report does. */
  const air = (state: FlightControlState) => gui.handleMessage(JSON.parse(JSON.stringify(state)));
  const commands = () => sent.filter((m): m is FlightControlCommand => m.type === "fc-command");
  const controls = (action: string) => sent.filter((m) => m.type === "fc-control" && m.action === action).length;
  return { gui, sent, views, air, commands, controls };
}

/** Keeps the air's state fresh while time passes. */
async function run(s: ReturnType<typeof setup>, ms: number, state: () => FlightControlState) {
  for (let t = 0; t < ms; t += 50) {
    s.air(state());
    await vi.advanceTimersByTimeAsync(50);
  }
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("FlightControlGui: unlock", () => {
  it("sends nothing and ignores stick keys before the PP is unlocked", async () => {
    const s = setup();
    await run(s, 1_000, () => fcState("HANDED_OVER"));
    expect(s.gui.keyDown("KeyW")).toBeNull();
    expect(s.gui.keyDown("Space")).toBeNull();
    s.gui.setPad("right", { pitch: 1 });
    await run(s, 500, () => fcState("HANDED_OVER"));
    expect(s.sent).toEqual([]);
    expect(s.gui.view).toMatchObject({ unlockOffered: true, unlocked: false, streaming: false, abortEnabled: false });
  });

  it("unlocks only after a continuous 1.5 s hold, then streams at once and stops re-sending when the air is ACTIVE", async () => {
    const s = setup();
    s.air(fcState("HANDED_OVER"));
    s.gui.pressUnlock();
    await run(s, 1_400, () => fcState("HANDED_OVER"));
    s.gui.releaseUnlock();
    expect(s.controls("unlock")).toBe(0);
    expect(s.gui.view.unlockProgress).toBe(0);

    s.gui.pressUnlock();
    await run(s, 1_000, () => fcState("HANDED_OVER"));
    expect(s.gui.view.unlockProgress).toBeCloseTo(1_000 / 1_500, 1);
    await run(s, 550, () => fcState("HANDED_OVER"));
    expect(s.controls("unlock")).toBeGreaterThanOrEqual(1);
    expect(s.gui.view).toMatchObject({ pending: ["unlock"], unlockOffered: false, abortEnabled: true, unlocked: false });
    expect(s.commands().length).toBeGreaterThan(0); // the heartbeat starts with the unlock

    await run(s, 400, () => fcState("HANDED_OVER"));
    const unlocks = s.controls("unlock");
    expect(unlocks).toBeGreaterThanOrEqual(3); // re-sent every 200 ms
    await run(s, 500, () => fcState("ACTIVE", { reason: "unlocked" }));
    expect(s.controls("unlock")).toBe(unlocks);
    expect(s.gui.view).toMatchObject({ unlocked: true, streaming: true, pending: [] });
  });

  it("supports a held Enter key, ignoring OS key repeat", async () => {
    const s = setup();
    s.air(fcState("HANDED_OVER"));
    expect(s.gui.keyDown("Enter")).toBe("unlock");
    await run(s, 700, () => fcState("HANDED_OVER"));
    expect(s.gui.keyDown("Enter", true)).toBe("unlock");
    s.gui.keyUp("Enter");
    s.gui.keyUp("Enter");
    expect(s.gui.view.unlockProgress).toBe(0);
    expect(s.gui.keyDown("NumpadEnter")).toBe("unlock");
    await run(s, 1_550, () => fcState("HANDED_OVER"));
    expect(s.controls("unlock")).toBe(1);
    expect(s.gui.keyDown("Enter")).toBeNull(); // no longer offered while the unlock is pending
  });

  it("isn't offered on no-go, and a hold is dropped when the offer goes away", async () => {
    const s = setup();
    s.gui.setRtt(null);
    s.air(fcState("HANDED_OVER"));
    expect(s.gui.view.unlockOffered).toBe(false);
    s.gui.pressUnlock();
    expect(s.gui.view.unlockProgress).toBe(0);

    s.gui.setRtt(50);
    s.gui.pressUnlock();
    await run(s, 500, () => fcState("HANDED_OVER"));
    await run(s, 1_500, () => fcState("RELEASED", { reason: "sp-took-control" }));
    expect(s.controls("unlock")).toBe(0);
    expect(s.gui.view.unlockProgress).toBe(0);
  });

  it("stops re-sending an unlock the air refused, and gives up after 3 s", async () => {
    const s = setup();
    s.air(fcState("HANDED_OVER"));
    s.gui.pressUnlock();
    await run(s, 1_550, () => fcState("HANDED_OVER"));
    s.air(fcState("HANDED_OVER", { reason: "unlock-refused:sticks-not-neutral" }));
    expect(s.gui.view.pending).toEqual([]);
    expect(s.gui.view.supervisor.reason).toMatch(/sticks are not centered/);

    s.gui.pressUnlock();
    await run(s, 1_550, () => fcState("HANDED_OVER"));
    await run(s, 3_000, () => fcState("HANDED_OVER"));
    expect(s.gui.view.pending).toEqual([]);
  });
});

describe("FlightControlGui: command stream", () => {
  it("streams fc-command at 20 Hz with zeros when idle and the held keys otherwise", async () => {
    const s = setup();
    await run(s, 1_000, () => fcState("ACTIVE"));
    const idle = s.commands();
    expect(idle.length).toBe(20);
    expect(idle.every((c) => c.roll === 0 && c.pitch === 0 && c.yaw === 0 && c.throttle === 0)).toBe(true);
    expect(idle.map((c) => c.seq)).toEqual(idle.map((_, i) => i + 1));

    expect(s.gui.keyDown("KeyW")).toBe("stick");
    expect(s.gui.keyDown("KeyE")).toBe("stick");
    expect(s.gui.keyDown("KeyW", true)).toBe("stick");
    await run(s, 100, () => fcState("ACTIVE"));
    expect(s.commands().at(-1)).toMatchObject({ pitch: 0.5, yaw: 0.5, roll: 0, throttle: 0 });
    s.gui.keyUp("KeyW");
    await run(s, 100, () => fcState("ACTIVE"));
    expect(s.commands().at(-1)).toMatchObject({ pitch: 0, yaw: 0.5 });
    s.gui.keyUp("KeyE");
    s.gui.keyUp("KeyX");
    await run(s, 100, () => fcState("ACTIVE"));
    expect(s.commands().at(-1)).toMatchObject({ pitch: 0, yaw: 0 });
    expect(s.commands().length).toBe(26); // releasing keys never stops the stream
  });

  it("honours on-screen pads and the deflection sliders", async () => {
    const s = setup();
    s.air(fcState("ACTIVE"));
    s.gui.input.setDeflection("throttle", 0.2);
    s.gui.setPad("left", { throttle: 1 });
    await run(s, 100, () => fcState("ACTIVE"));
    expect(s.commands().at(-1)).toMatchObject({ throttle: 0.2 });
    s.gui.setPad("left", null);
    await run(s, 100, () => fcState("ACTIVE"));
    expect(s.commands().at(-1)).toMatchObject({ throttle: 0 });
  });

  it("reports how old the air's last applied command was", async () => {
    const s = setup();
    await run(s, 200, () => fcState("ACTIVE"));
    const last = s.commands().at(-1)!;
    await vi.advanceTimersByTimeAsync(30);
    s.air(fcState("ACTIVE", { lastAppliedSeq: last.seq }));
    expect(s.gui.view.commandAgeMs).toBe(30);
    s.air(fcState("ACTIVE", { lastAppliedSeq: 999_999 }));
    expect(s.gui.view.commandAgeMs).toBe(30);
  });

  it("keeps only recent seqs", async () => {
    const s = setup();
    await run(s, 12_000, () => fcState("ACTIVE"));
    s.air(fcState("ACTIVE", { lastAppliedSeq: 1 }));
    expect(s.gui.view.commandAgeMs).toBeNull();
  });
});

describe("FlightControlGui: ABORT and hand back", () => {
  it("sends abort at once on Space/Esc and every tick until the air reports ABORTED, then streams zeros", async () => {
    const s = setup();
    s.air(fcState("ACTIVE"));
    s.gui.keyDown("KeyD");
    await run(s, 100, () => fcState("ACTIVE"));
    expect(s.gui.keyDown("Space")).toBe("abort");
    expect(s.controls("abort")).toBe(1);
    expect(s.gui.keyDown("Escape", true)).toBe("abort");
    await run(s, 200, () => fcState("ACTIVE"));
    expect(s.controls("abort")).toBe(5);
    await run(s, 500, () => fcState("ABORTED", { reason: "abort" }));
    expect(s.controls("abort")).toBe(5);
    expect(s.gui.view).toMatchObject({ unlocked: true, streaming: true, abortEnabled: false, banner: { text: "Aborted – hovering" } });
    expect(s.commands().at(-1)).toMatchObject({ roll: 0, pitch: 0, yaw: 0, throttle: 0 });
    expect(s.gui.keyDown("KeyD")).toBeNull();
    expect(s.gui.view.unlockOffered).toBe(true); // continuing needs a new hold-to-unlock

    s.gui.pressUnlock();
    await run(s, 1_550, () => fcState("ABORTED", { reason: "abort" }));
    expect(s.controls("unlock")).toBeGreaterThanOrEqual(1);
    await run(s, 100, () => fcState("ACTIVE", { reason: "unlocked" }));
    expect(s.gui.view.pending).toEqual([]);
  });

  it("can abort right after unlocking, and settles if the air leaves the flying states", async () => {
    const s = setup();
    s.air(fcState("HANDED_OVER"));
    s.gui.pressUnlock();
    await run(s, 1_550, () => fcState("HANDED_OVER"));
    s.gui.abort();
    expect(s.controls("abort")).toBe(1);
    s.air(fcState("RELEASED", { reason: "sp-took-control" }));
    expect(s.gui.view.pending).toEqual([]);
    s.gui.abort();
    expect(s.controls("abort")).toBe(1);
  });

  it("hands back with release, re-sent until RELEASED, and stops streaming", async () => {
    const s = setup();
    s.air(fcState("ACTIVE"));
    s.gui.handBack();
    await run(s, 450, () => fcState("ACTIVE"));
    expect(s.controls("release")).toBe(3);
    await run(s, 300, () => fcState("RELEASED", { reason: "ground-release" }));
    expect(s.controls("release")).toBe(3);
    const commands = s.commands().length;
    await run(s, 500, () => fcState("RELEASED", { reason: "ground-release" }));
    expect(s.commands()).toHaveLength(commands);
    expect(s.gui.view.banner?.text).toBe("Handed back – safety pilot in control");
    s.gui.handBack();
    expect(s.controls("release")).toBe(3);
  });

  it("can hand back while locked, and ignores hand back without state", () => {
    const s = setup();
    s.gui.handBack();
    expect(s.sent).toEqual([]);
    s.air(fcState("HANDED_OVER"));
    s.gui.handBack();
    expect(s.controls("release")).toBe(1);
  });
});

describe("FlightControlGui: dead-man", () => {
  const triggers: [string, (s: ReturnType<typeof setup>) => void, (s: ReturnType<typeof setup>) => void][] = [
    ["window-blurred", (s) => s.gui.setWindowFocused(false), (s) => s.gui.setWindowFocused(true)],
    ["page-hidden", (s) => s.gui.setPageVisible(false), (s) => s.gui.setPageVisible(true)],
    ["socket-closed", (s) => s.gui.setSocketOpen(false), (s) => {
      s.gui.setSocketOpen(true);
      s.gui.handleMessage({ type: "fc-channel", open: true });
    }],
    ["channel-closed", (s) => s.gui.handleMessage({ type: "fc-channel", open: false }), (s) => s.gui.handleMessage({ type: "fc-channel", open: true })],
    ["rtt-high", (s) => s.gui.setRtt(401), (s) => s.gui.setRtt(399)],
  ];

  it.each(triggers)("stops the stream and releases the keys on %s", async (reason, trigger, restore) => {
    const s = setup();
    s.air(fcState("ACTIVE"));
    s.gui.keyDown("KeyR");
    await run(s, 200, () => fcState("ACTIVE"));
    trigger(s);
    const commands = s.commands().length;
    await vi.advanceTimersByTimeAsync(300);
    expect(s.commands()).toHaveLength(commands);
    expect(s.gui.view.deadMan).toContain(reason);
    expect(s.gui.view.streaming).toBe(false);

    restore(s);
    await run(s, 200, () => fcState("NEUTRAL"));
    expect(s.gui.view.deadMan).toEqual([]);
    expect(s.commands().length).toBeGreaterThan(commands);
    expect(s.commands().at(-1)).toMatchObject({ throttle: 0 }); // the held key was released
  });

  it("stops when commands reach the air late, even while the RTT looks fine, until the air releases", async () => {
    const s = setup();
    await run(s, 200, () => fcState("ACTIVE"));
    const recent = s.commands().at(-1)!;
    await run(s, 100, () => fcState("ACTIVE", { lastAppliedSeq: recent.seq })); // ~100 ms old: fine
    expect(s.gui.view.deadMan).toEqual([]);

    const late = s.commands().at(-1)!;
    await vi.advanceTimersByTimeAsync(650);
    s.air(fcState("ACTIVE", { lastAppliedSeq: late.seq }));
    expect(s.gui.view.commandAgeMs).toBeGreaterThan(600);
    expect(s.gui.view.deadMan).toEqual(["commands-late"]);
    const stopped = s.commands().length;
    await run(s, 300, () => fcState("NEUTRAL", { lastAppliedSeq: late.seq })); // latched through NEUTRAL
    expect(s.commands()).toHaveLength(stopped);
    await run(s, 100, () => fcState("RELEASED", { reason: "heartbeat-lost" }));
    expect(s.gui.view.deadMan).toEqual([]);
  });

  it("lets a brief gap resume from NEUTRAL, but stops once the air's last command is older than its release timeout", async () => {
    const s = setup();
    await run(s, 200, () => fcState("ACTIVE"));
    const last = s.commands().at(-1)!;
    await vi.advanceTimersByTimeAsync(400);
    s.air(fcState("NEUTRAL", { lastAppliedSeq: last.seq, reason: "heartbeat-lost" })); // ~400 ms old
    expect(s.gui.view.deadMan).toEqual([]);
    expect(s.gui.view.streaming).toBe(true);

    await vi.advanceTimersByTimeAsync(700);
    s.air(fcState("NEUTRAL", { lastAppliedSeq: last.seq, reason: "heartbeat-lost" })); // > 1 s old
    expect(s.gui.view.commandAgeMs).toBeGreaterThan(1_000);
    expect(s.gui.view.deadMan).toEqual(["commands-late"]);
    expect(s.gui.view.streaming).toBe(false);
  });

  it("doesn't latch on a late report while ABORTED (the hover heartbeat must go on)", async () => {
    const s = setup();
    await run(s, 200, () => fcState("ABORTED"));
    const old = s.commands()[0];
    s.air(fcState("ABORTED", { lastAppliedSeq: old.seq }));
    await run(s, 200, () => fcState("ABORTED", { lastAppliedSeq: old.seq }));
    expect(s.gui.view.deadMan).toEqual([]);
    expect(s.gui.view.streaming).toBe(true);
  });

  it("stops when the air's state goes stale", async () => {
    const s = setup();
    await run(s, 200, () => fcState("ACTIVE"));
    const commands = s.commands().length;
    await vi.advanceTimersByTimeAsync(1_000);
    expect(s.gui.view.deadMan).toEqual(["state-stale"]);
    expect(s.commands().length).toBeLessThanOrEqual(commands + 20);
    const after = s.commands().length;
    await vi.advanceTimersByTimeAsync(1_000);
    expect(s.commands()).toHaveLength(after);
  });

  it("drops a running unlock hold when the window loses focus", () => {
    const s = setup();
    s.air(fcState("HANDED_OVER"));
    s.gui.pressUnlock();
    s.gui.setWindowFocused(false);
    expect(s.gui.view.unlockProgress).toBe(0);
  });

  it("ignores a nonsensical RTT", () => {
    const s = setup();
    s.gui.setRtt(-5);
    s.air(fcState("HANDED_OVER"));
    expect(s.gui.view.goNoGo.items.find((item) => item.key === "rtt")?.detail).toBe("unknown");
  });
});

describe("FlightControlGui: setting and messages", () => {
  it("re-sends fc-setting until the air reflects it, only while allowed", async () => {
    const s = setup();
    const off = () => fcState("IDLE", { flightControlEnabled: false, link: { mode: "transparent", reason: "setting-disabled", detectedType: "msp-v1" } });
    s.air(off());
    s.gui.setFlightControlEnabled(true);
    await run(s, 600, off);
    const settings = s.sent.filter((m) => m.type === "fc-setting");
    expect(settings.length).toBe(3);
    expect(settings[0]).toEqual({ type: "fc-setting", flightControlEnabled: true });
    await run(s, 600, () => fcState("IDLE"));
    expect(s.sent.filter((m) => m.type === "fc-setting")).toHaveLength(3);

    s.air(fcState("ACTIVE"));
    s.gui.setFlightControlEnabled(false);
    expect(s.sent.filter((m) => m.type === "fc-setting")).toHaveLength(3);
  });

  it("gives up re-sending after 3 s", async () => {
    const s = setup();
    const off = () => fcState("IDLE", { flightControlEnabled: false });
    s.air(off());
    s.gui.setFlightControlEnabled(true);
    await run(s, 4_000, off);
    expect(s.sent.filter((m) => m.type === "fc-setting").length).toBeLessThanOrEqual(13);
    expect(s.gui.view.pending).toEqual([]);
  });

  it("consumes only flight-control messages, and shows the relay's flight-control errors", () => {
    const s = setup();
    expect(s.gui.handleMessage({ type: "air-status" })).toBe(false);
    expect(s.gui.handleMessage({ type: "fc-state", bogus: true })).toBe(false);
    expect(s.gui.handleMessage(null)).toBe(false);
    expect(s.gui.handleMessage({ type: "error", message: "A GUI viewer is already connected." })).toBe(false);
    expect(s.gui.handleMessage({ type: "error", message: 42 })).toBe(false);
    expect(s.gui.handleMessage({ type: "error", message: "No flight-control channel to the drone." })).toBe(true);
    expect(s.gui.view.lastError).toBe("No flight-control channel to the drone.");
    s.air(fcState());
    expect(s.gui.view.lastError).toBeNull();
    s.gui.handleMessage({ type: "fc-channel", open: false });
    expect(s.gui.view).toMatchObject({ noState: true, channelOpen: false });
  });

  it("stops ticking and notifying once disposed", async () => {
    const s = setup();
    s.air(fcState("ACTIVE"));
    const unsubscribe = s.gui.onChange(() => undefined);
    unsubscribe();
    s.gui.dispose();
    s.gui.dispose();
    const views = s.views.length;
    await vi.advanceTimersByTimeAsync(500);
    s.air(fcState("ACTIVE"));
    expect(s.commands()).toHaveLength(0);
    expect(s.views).toHaveLength(views);
  });
});
