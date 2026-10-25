import {
  parseFlightControlAirMessage,
  type FlightControlGroundMessage,
  type FlightControlState,
  type SupervisorState,
} from "@dronelink/core-transport";
import { systemGuiClock, type GuiClock } from "./clock.js";
import { HoldToConfirm } from "./hold-to-confirm.js";
import { StickInput, type StickValues } from "./stick-input.js";
import { describeFlightControl, RTT_GATE_MS, type FlightControlView } from "./view.js";

export type DeadManReason = "window-blurred" | "page-hidden" | "socket-closed" | "channel-closed" | "rtt-high" | "state-stale";

export const DEAD_MAN_TEXT: Record<DeadManReason, string> = {
  "window-blurred": "window lost focus",
  "page-hidden": "tab hidden",
  "socket-closed": "connection to the ground station lost",
  "channel-closed": "flight-control channel closed",
  "rtt-high": `round trip above ${RTT_GATE_MS} ms`,
  "state-stale": "no current state from the air unit",
};

export type PendingAction = "unlock" | "abort" | "release" | "setting";

export interface FlightControlGuiView extends FlightControlView {
  /** The air reports HANDED_OVER (or ABORTED) and go/no-go is green: the hold-to-unlock control is offered. */
  unlockOffered: boolean;
  unlockProgress: number;
  /** The air reports ACTIVE, NEUTRAL or ABORTED (the PP holds the controls). */
  unlocked: boolean;
  /** ABORT is enabled: the PP is unlocked (or an unlock was just sent). */
  abortEnabled: boolean;
  streaming: boolean;
  deadMan: DeadManReason[];
  /** Time from sending the command the air last applied to the report that said so. */
  commandAgeMs: number | null;
  sticks: StickValues;
  pending: PendingAction[];
  lastError: string | null;
}

export interface FlightControlGuiOptions {
  /** Sends a ground -> air message over the GUI's signaling WebSocket. */
  send: (message: FlightControlGroundMessage) => void;
  clock?: GuiClock;
  unlockHoldMs?: number;
  commandRateHz?: number;
}

export type KeyResult = "abort" | "unlock" | "stick" | null;

const UNLOCKED_STATES: ReadonlySet<SupervisorState> = new Set(["ACTIVE", "NEUTRAL", "ABORTED"]);
const FLYING_STATES: ReadonlySet<SupervisorState> = new Set(["ACTIVE", "NEUTRAL"]);
const RESEND_MS: Record<PendingAction, number> = { unlock: 200, abort: 0, release: 200, setting: 250 };
const GIVE_UP_MS = 3_000;
const SEQ_HISTORY = 200;

interface Pending {
  since: number;
  lastSentAt: number;
  message: FlightControlGroundMessage;
}

/**
 * Ground GUI flight-control logic (issues #87 and #88), DOM-free so it is unit-testable:
 * - the hold-to-unlock manoeuvre, offered only when the air reports HANDED_OVER and go/no-go is green
 * - the 20 Hz fc-command stream, the heartbeat that keeps the air out of NEUTRAL; zeros when idle
 * - the ground dead-man (blur, hidden tab, WebSocket loss, RTT gate, closed channel, stale
 *   state), which stops the stream so the air goes NEUTRAL, then RELEASED
 * - ABORT / hand back / setting, re-sent until the air's fc-state reflects them, since the
 *   flight-control channel is unreliable
 * Everything shown about the lock comes from the air's fc-state, never from a local guess.
 */
export class FlightControlGui {
  readonly input = new StickInput();
  private readonly send: (message: FlightControlGroundMessage) => void;
  private readonly clock: GuiClock;
  private readonly hold: HoldToConfirm;
  private readonly listeners = new Set<(view: FlightControlGuiView) => void>();
  private readonly pending = new Map<PendingAction, Pending>();
  private readonly sentSeqs = new Map<number, number>();
  private readonly ticker: unknown;

  private state: FlightControlState | null = null;
  private receivedAt: number | null = null;
  private channelOpen = false;
  private socketOpen = false;
  private rttMs: number | null = null;
  private windowFocused = true;
  private pageVisible = true;
  private seq = 0;
  private commandAgeMs: number | null = null;
  private lastError: string | null = null;
  private wasStreaming = false;
  private disposed = false;

  constructor(options: FlightControlGuiOptions) {
    this.send = options.send;
    this.clock = options.clock ?? systemGuiClock;
    this.hold = new HoldToConfirm(options.unlockHoldMs ?? 1_500);
    this.ticker = this.clock.setInterval(() => this.tick(), 1_000 / (options.commandRateHz ?? 20));
  }

  // --- inputs from the page ---------------------------------------------------

  /** Feeds a message from the GUI signaling socket; true when it was a flight-control message. */
  handleMessage(message: unknown): boolean {
    if (typeof message === "object" && message !== null && (message as { type?: unknown }).type === "error") {
      const text = (message as { message?: unknown }).message;
      if (typeof text === "string" && /flight-control/i.test(text)) {
        this.lastError = text;
        this.emit();
        return true;
      }
      return false;
    }
    const parsed = parseFlightControlAirMessage(message);
    if (!parsed) return false;
    if (parsed.type === "fc-channel") {
      this.channelOpen = parsed.open;
      if (!parsed.open) this.state = null;
    } else {
      this.state = parsed;
      this.receivedAt = this.clock.now();
      this.channelOpen = true;
      this.lastError = null;
      const sentAt = parsed.supervisor.lastAppliedSeq === null ? undefined : this.sentSeqs.get(parsed.supervisor.lastAppliedSeq);
      if (sentAt !== undefined) this.commandAgeMs = this.receivedAt - sentAt;
      this.settlePending();
    }
    this.emit();
    return true;
  }

  setSocketOpen(open: boolean): void {
    this.socketOpen = open;
    if (!open) {
      this.channelOpen = false;
    }
    this.emit();
  }

  /** The air-measured data-channel round trip (air-status rttMs). */
  setRtt(rttMs: number | null): void {
    this.rttMs = rttMs !== null && Number.isFinite(rttMs) && rttMs >= 0 ? rttMs : null;
  }

  setWindowFocused(focused: boolean): void {
    this.windowFocused = focused;
    if (!focused) this.releaseAllInputs();
    this.emit();
  }

  setPageVisible(visible: boolean): void {
    this.pageVisible = visible;
    if (!visible) this.releaseAllInputs();
    this.emit();
  }

  // --- operator actions -------------------------------------------------------

  setFlightControlEnabled(enabled: boolean): void {
    if (!this.view.settingChangeAllowed) return;
    this.startPending("setting", { type: "fc-setting", flightControlEnabled: enabled });
  }

  pressUnlock(): void {
    if (!this.unlockOffered()) return;
    this.hold.press(this.clock.now());
    this.emit();
  }

  releaseUnlock(): void {
    this.hold.release();
    this.emit();
  }

  /** Immediately, and again on every tick until the air reports ABORTED. */
  abort(): void {
    if (!this.abortEnabled()) return;
    this.pending.delete("unlock");
    this.input.clear();
    this.startPending("abort", { type: "fc-control", action: "abort" });
  }

  /** Hands the sticks back to the SP without the switch (secondary to ABORT). */
  handBack(): void {
    const airState = this.airState();
    if (airState === null || !(airState === "HANDED_OVER" || UNLOCKED_STATES.has(airState))) return;
    this.pending.delete("unlock");
    this.input.clear();
    this.startPending("release", { type: "fc-control", action: "release" });
  }

  /**
   * Keyboard: Space/Esc = ABORT, Enter held = unlock, W/S/A/D, arrows, Q/E, R/F = sticks.
   * OS auto-repeat is ignored (a key is held from keydown to keyup). Returns what the key did,
   * so the caller can preventDefault it.
   */
  keyDown(code: string, repeat = false): KeyResult {
    if (code === "Space" || code === "Escape") {
      if (!this.abortEnabled()) return null;
      if (!repeat) this.abort();
      return "abort";
    }
    if (code === "Enter" || code === "NumpadEnter") {
      if (!this.unlockOffered() && !this.hold.holding) return null;
      if (!repeat) this.pressUnlock();
      return "unlock";
    }
    if (!StickInput.isStickKey(code)) return null;
    if (!this.flying()) return null;
    if (!repeat && this.input.keyDown(code)) this.emit();
    return "stick";
  }

  keyUp(code: string): void {
    if (code === "Enter" || code === "NumpadEnter") {
      if (this.hold.holding) this.releaseUnlock();
      return;
    }
    if (this.input.keyUp(code)) this.emit();
  }

  /** An on-screen pad direction; ignored unless the PP is flying. */
  setPad(id: string, values: Partial<StickValues> | null): void {
    if (values !== null && !this.flying()) return;
    this.input.setPad(id, values);
    this.emit();
  }

  onChange(listener: (view: FlightControlGuiView) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.clock.clearInterval(this.ticker);
    this.listeners.clear();
  }

  get view(): FlightControlGuiView {
    const now = this.clock.now();
    const base = describeFlightControl(this.state, {
      now,
      receivedAt: this.receivedAt,
      channelOpen: this.channelOpen,
      rttMs: this.rttMs,
    });
    const airState = base.supervisor.state;
    const deadMan = this.deadMan(base.stale);
    return {
      ...base,
      unlockOffered: this.unlockOffered(base),
      unlockProgress: this.hold.progress(now),
      unlocked: airState !== null && UNLOCKED_STATES.has(airState),
      abortEnabled: this.abortEnabled(),
      streaming: this.streamWanted(airState) && deadMan.length === 0,
      deadMan,
      commandAgeMs: this.commandAgeMs,
      sticks: this.input.values(),
      pending: [...this.pending.keys()],
      lastError: this.lastError,
    };
  }

  // --- internals --------------------------------------------------------------

  private airState(): SupervisorState | null {
    return this.state?.supervisor.state ?? null;
  }

  private flying(): boolean {
    const airState = this.airState();
    return airState !== null && FLYING_STATES.has(airState);
  }

  private unlockOffered(view = describeFlightControl(this.state, {
    now: this.clock.now(),
    receivedAt: this.receivedAt,
    channelOpen: this.channelOpen,
    rttMs: this.rttMs,
  })): boolean {
    const lockedState = view.supervisor.state === "HANDED_OVER" || view.supervisor.state === "ABORTED";
    return lockedState && view.goNoGo.go && !this.pending.has("unlock");
  }

  private abortEnabled(): boolean {
    return this.flying() || (this.pending.has("unlock") && this.airState() === "HANDED_OVER");
  }

  /** Unlocked per the air, or an unlock just sent: the heartbeat must already be flowing. */
  private streamWanted(airState: SupervisorState | null): boolean {
    if (airState === null) return false;
    return UNLOCKED_STATES.has(airState) || (this.pending.has("unlock") && airState === "HANDED_OVER");
  }

  private deadMan(stale: boolean): DeadManReason[] {
    const reasons: DeadManReason[] = [];
    if (!this.windowFocused) reasons.push("window-blurred");
    if (!this.pageVisible) reasons.push("page-hidden");
    if (!this.socketOpen) reasons.push("socket-closed");
    if (!this.channelOpen) reasons.push("channel-closed");
    if (this.rttMs !== null && this.rttMs > RTT_GATE_MS) reasons.push("rtt-high");
    if (stale) reasons.push("state-stale");
    return reasons;
  }

  private releaseAllInputs(): void {
    this.input.clear();
    this.hold.release();
  }

  private startPending(action: PendingAction, message: FlightControlGroundMessage): void {
    const now = this.clock.now();
    this.pending.set(action, { since: now, lastSentAt: now, message });
    this.send(message);
    this.emit();
  }

  /** Drops pending actions the air's state now reflects. */
  private settlePending(): void {
    const state = this.state!;
    const airState = state.supervisor.state;
    const done: Record<PendingAction, boolean> = {
      unlock:
        (airState !== "HANDED_OVER" && airState !== "ABORTED") || (state.supervisor.reason?.startsWith("unlock-refused:") ?? false),
      abort: airState === "ABORTED" || !FLYING_STATES.has(airState),
      release: airState === "RELEASED" || airState === "IDLE",
      setting: state.flightControlEnabled === (this.pending.get("setting")?.message as { flightControlEnabled?: boolean } | undefined)?.flightControlEnabled,
    };
    for (const action of [...this.pending.keys()]) {
      if (done[action]) this.pending.delete(action);
    }
  }

  private tick(): void {
    const now = this.clock.now();
    if (this.hold.update(now)) {
      this.hold.release();
      if (this.unlockOffered()) this.startPending("unlock", { type: "fc-control", action: "unlock" });
    } else if (this.hold.holding && !this.unlockOffered()) {
      this.hold.release(); // the offer went away mid-hold (e.g. SP took back control)
    }

    for (const [action, pending] of this.pending) {
      if (now - pending.since >= GIVE_UP_MS) {
        this.pending.delete(action);
        continue;
      }
      if (now - pending.lastSentAt >= RESEND_MS[action]) {
        pending.lastSentAt = now;
        this.send(pending.message);
      }
    }

    const view = this.view;
    if (view.streaming) {
      this.sendCommand(view.supervisor.state === "ABORTED" ? { roll: 0, pitch: 0, yaw: 0, throttle: 0 } : view.sticks);
    } else if (this.wasStreaming || !view.unlocked) {
      this.input.clear(); // a stopped stream releases every held control
    }
    this.wasStreaming = view.streaming;
    this.emitView(this.view);
  }

  private sendCommand(sticks: StickValues): void {
    const sentAt = this.clock.now();
    this.seq++;
    this.sentSeqs.set(this.seq, sentAt);
    if (this.sentSeqs.size > SEQ_HISTORY) this.sentSeqs.delete(this.seq - SEQ_HISTORY);
    this.send({ type: "fc-command", seq: this.seq, sentAt, ...sticks });
  }

  private emit(): void {
    if (this.listeners.size > 0) this.emitView(this.view);
  }

  private emitView(view: FlightControlGuiView): void {
    if (this.disposed) return;
    for (const listener of this.listeners) listener(view);
  }
}
