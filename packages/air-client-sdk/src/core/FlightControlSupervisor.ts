import type { FlightControlAction, FlightControlCommand, SupervisorState } from "@dronelink/core-transport";
import { systemClock, type Clock } from "./Clock.js";

/** What the supervisor needs from the identified FC. */
export interface SupervisorIdentity {
  /** ap_hover_throttle: the throttle neutral. */
  hoverThrottleUs: number;
  /** Raw receiver channel per function, internal order R, P, Y, T, AUX1.. (MSP_RX_MAP). */
  rxMap: readonly number[];
}

/** FC state from the telemetry poller. */
export interface SupervisorFcState {
  /** When the MSP_STATUS_EX reply these flags come from arrived. */
  receivedAt: number;
  armed: boolean;
  posHold: boolean;
  mspOverride: boolean;
  rxFailsafe: boolean;
  gpsFix: boolean;
  numSat: number;
  /** MSP_RC in internal order R, P, Y, T, AUX1.., or null before the first reply. */
  rc: { channels: readonly number[]; receivedAt: number } | null;
}

export interface SupervisorInputs {
  flightControlEnabled: boolean;
  /** Identification gate reports `verified` for this identity; null otherwise. */
  identity: SupervisorIdentity | null;
  fcLinkHealthy: boolean;
  channelOpen: boolean;
  pageVisible: boolean;
  fc: SupervisorFcState | null;
}

export interface SupervisorConfig {
  commandRateHz: number;
  /** No valid command for this long in ACTIVE -> NEUTRAL (all sticks center). */
  neutralTimeoutMs: number;
  /** No valid command for this long in NEUTRAL or ABORTED -> RELEASED. */
  releaseTimeoutMs: number;
  maxDeflectionUs: { roll: number; pitch: number; yaw: number; throttle: number };
  /** Time for an output to slew across the full -1..1 range. */
  slewFullRangeMs: number;
  minSats: number;
  /** FC status older than this counts as missing. */
  maxStatusAgeMs: number;
  /** unlock needs the SP's roll/pitch/yaw within this of 1500 (pos-hold deadband). */
  stickNeutralToleranceUs: number;
  /** unlock needs the SP's throttle within this of the hover throttle (alt-hold deadband). */
  throttleNeutralToleranceUs: number;
  /** After unlock, MSP_RC must show the sent stick values within this long. */
  maskCheckTimeoutMs: number;
  maskCheckToleranceUs: number;
  /**
   * A gap this long since the last frame means Betaflight has already given the sticks back to
   * the SP (RX_MSP_RC_FRAME_FRESH_MS): the air was stalled (frozen tab, throttled WebView) and
   * must release rather than resume with commands that queued up meanwhile.
   */
  frameGapReleaseMs: number;
}

export const DEFAULT_SUPERVISOR_CONFIG: SupervisorConfig = {
  commandRateHz: 20,
  neutralTimeoutMs: 250,
  releaseTimeoutMs: 1_000,
  maxDeflectionUs: { roll: 150, pitch: 150, yaw: 150, throttle: 150 },
  slewFullRangeMs: 500,
  minSats: 8,
  maxStatusAgeMs: 500,
  stickNeutralToleranceUs: 25,
  throttleNeutralToleranceUs: 50,
  maskCheckTimeoutMs: 1_000,
  maskCheckToleranceUs: 2,
  frameGapReleaseMs: 300,
};

export interface SupervisorSnapshot {
  state: SupervisorState;
  reason: string | null;
  lastAppliedSeq: number | null;
}

export interface FlightControlSupervisorOptions {
  /** Writes one MSP_SET_RAW_RC frame: the four stick channels in raw receiver order. */
  sendRc: (rawChannels: number[]) => void;
  clock?: Clock;
  config?: Partial<SupervisorConfig>;
}

type Axes = [roll: number, pitch: number, yaw: number, throttle: number];

const CENTER: Axes = [0, 0, 0, 0];
const STICK_CENTER_US = 1500;
const SENDING_STATES: ReadonlySet<SupervisorState> = new Set(["ACTIVE", "NEUTRAL", "ABORTED"]);
const HANDED_OVER_STATES: ReadonlySet<SupervisorState> = new Set(["HANDED_OVER", "ACTIVE", "NEUTRAL", "ABORTED"]);
const MASK_HISTORY = 20;

const INITIAL_INPUTS: SupervisorInputs = {
  flightControlEnabled: false,
  identity: null,
  fcLinkHealthy: false,
  channelOpen: false,
  pageVisible: true,
  fc: null,
};

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

/** True when the first four RX map entries are a permutation of raw channels 0-3. */
export function isStickRxMap(rxMap: readonly number[]): boolean {
  const sticks = rxMap.slice(0, 4);
  return sticks.length === 4 && [0, 1, 2, 3].every((channel) => sticks.includes(channel));
}

/**
 * Air-side flight-control safety supervisor (ARCHITECTURE.md 7.7 / 7.8, issue #86).
 *
 * IDLE -> HANDED_OVER (locked) -> unlock -> ACTIVE <-> NEUTRAL, ABORTED, RELEASED. Only ACTIVE,
 * NEUTRAL and ABORTED send MSP_SET_RAW_RC; NEUTRAL and ABORTED send all four sticks at center.
 * Losing any precondition while handed over releases at once, which stops the frames so the FC
 * falls back to the safety pilot's RC. From RELEASED, flight control needs a fresh handover: the
 * SP's MSP OVERRIDE switch has to be seen off (-> IDLE) before it can hand over again.
 *
 * All timing uses the injected clock; there is no direct setTimeout/Date.now here.
 */
export class FlightControlSupervisor {
  private readonly sink: (rawChannels: number[]) => void;
  private readonly clock: Clock;
  private readonly config: SupervisorConfig;
  private readonly listeners = new Set<(snapshot: SupervisorSnapshot) => void>();
  private inputs: SupervisorInputs = { ...INITIAL_INPUTS };

  private current: SupervisorState = "IDLE";
  private currentReason: string | null = null;
  private lastSeq: number | null = null;
  private appliedSeq: number | null = null;
  private lastCommandAt = 0;
  private target: Axes = [...CENTER];
  private output: Axes = [...CENTER];
  private lastTickAt = 0;
  private ticker: unknown = null;
  /** One-shot timer at the exact neutral/release deadline, so the 20 Hz tick adds no jitter. */
  private watchdog: unknown = null;
  private maskCheckDeadline: number | null = null;
  private sentFrames: { at: number; values: Axes }[] = [];
  private dropped = 0;
  private refused = 0;
  private framesSent = 0;
  private lastFrameAt = 0;
  private disposed = false;
  /** The SP's MSP OVERRIDE switch has been seen off since the last handover or reset. */
  private switchSeenOff = false;

  constructor(options: FlightControlSupervisorOptions) {
    this.sink = options.sendRc;
    this.clock = options.clock ?? systemClock;
    this.config = { ...DEFAULT_SUPERVISOR_CONFIG, ...options.config };
  }

  get state(): SupervisorState {
    return this.current;
  }

  get snapshot(): SupervisorSnapshot {
    return { state: this.current, reason: this.currentReason, lastAppliedSeq: this.appliedSeq };
  }

  /** fc-command messages dropped: stale seq, or received while not unlocked. */
  get droppedCommands(): number {
    return this.dropped;
  }

  get refusedUnlocks(): number {
    return this.refused;
  }

  get rcFramesSent(): number {
    return this.framesSent;
  }

  onChange(listener: (snapshot: SupervisorSnapshot) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /** Merges new inputs and re-checks the preconditions at once (not on the next tick). */
  update(inputs: Partial<SupervisorInputs>): void {
    if (this.disposed) return;
    if (inputs.channelOpen === true && !this.inputs.channelOpen) this.lastSeq = null; // a new GUI session restarts seq
    this.inputs = { ...this.inputs, ...inputs };
    this.evaluate();
    this.checkOverrideMask();
  }

  /** Back to IDLE, e.g. when a new FC link opens. Stops sending at once. */
  reset(reason: string): void {
    if (this.disposed) return;
    this.inputs = { ...this.inputs, identity: null, fcLinkHealthy: false, fc: null };
    this.switchSeenOff = false;
    this.transition("IDLE", reason);
  }

  handleCommand(command: FlightControlCommand): void {
    if (this.disposed) return;
    if (this.lastSeq !== null && command.seq <= this.lastSeq) {
      this.dropped++;
      return;
    }
    if (!SENDING_STATES.has(this.current)) {
      this.dropped++;
      return;
    }
    if (this.releaseIfStalled()) {
      this.dropped++;
      return;
    }
    this.lastSeq = command.seq;
    this.lastCommandAt = this.clock.now();
    this.armWatchdog();
    if (this.current === "ABORTED") return; // a live heartbeat keeps the hover; the values are ignored
    this.target = [command.roll, command.pitch, command.yaw, command.throttle].map((v) => clamp(v, -1, 1)) as Axes;
    this.appliedSeq = command.seq;
    if (this.current === "NEUTRAL") this.transition("ACTIVE", "heartbeat-restored");
  }

  handleControl(action: FlightControlAction): void {
    if (this.disposed) return;
    switch (action) {
      case "unlock":
        this.unlock();
        return;
      case "abort":
        if (this.current === "ACTIVE" || this.current === "NEUTRAL") this.transition("ABORTED", "abort");
        return;
      case "release":
        if (HANDED_OVER_STATES.has(this.current)) this.transition("RELEASED", "ground-release");
        return;
    }
  }

  dispose(): void {
    if (this.disposed) return;
    this.stopTicker();
    this.clock.clearTimeout(this.watchdog);
    this.disposed = true;
    this.current = "RELEASED";
    this.currentReason = "disposed";
  }

  // --- transitions ----------------------------------------------------------

  private unlock(): void {
    if (this.current === "ABORTED") {
      // A new unlock after ABORT resumes from center; the SP's sticks can't be read any more
      // (MSP_RC now reports the overridden values), and the hover is what is being sent.
      this.target = [...CENTER];
      this.lastCommandAt = this.clock.now();
      this.transition("ACTIVE", "unlocked");
      return;
    }
    if (this.current !== "HANDED_OVER") {
      this.refuse("unlock-refused:not-handed-over");
      return;
    }
    const neutral = this.spSticksNeutral();
    if (neutral !== null) {
      this.refuse(`unlock-refused:${neutral}`);
      return;
    }
    this.target = [...CENTER];
    this.output = [...CENTER];
    this.sentFrames = [];
    this.lastCommandAt = this.clock.now();
    this.maskCheckDeadline = this.clock.now() + this.config.maskCheckTimeoutMs;
    this.transition("ACTIVE", "unlocked");
  }

  /** null when the SP's sticks are at neutral; otherwise why not. */
  private spSticksNeutral(): string | null {
    const fc = this.inputs.fc;
    const identity = this.inputs.identity!;
    const rc = fc?.rc;
    if (!rc || this.clock.now() - rc.receivedAt > this.config.maxStatusAgeMs || rc.channels.length < 4) return "no-rc";
    const [roll, pitch, yaw, throttle] = rc.channels;
    const tolerance = this.config.stickNeutralToleranceUs;
    if ([roll, pitch, yaw].some((value) => Math.abs(value - STICK_CENTER_US) > tolerance)) return "sticks-not-neutral";
    if (Math.abs(throttle - identity.hoverThrottleUs) > this.config.throttleNeutralToleranceUs) return "sticks-not-neutral";
    return null;
  }

  private refuse(reason: string): void {
    this.refused++;
    this.currentReason = reason;
    this.emit();
  }

  /** The first precondition that isn't met, or null when all are. */
  private preconditionFailure(): string | null {
    const { flightControlEnabled, identity, fcLinkHealthy, channelOpen, pageVisible, fc } = this.inputs;
    if (!flightControlEnabled) return "setting-disabled";
    if (!fcLinkHealthy) return "fc-link-lost";
    if (!identity || !isStickRxMap(identity.rxMap)) return "not-verified";
    if (!channelOpen) return "channel-closed";
    if (!pageVisible) return "page-hidden";
    if (!fc || this.clock.now() - fc.receivedAt > this.config.maxStatusAgeMs) return "telemetry-stale";
    if (!fc.mspOverride) return "sp-took-control";
    if (!fc.posHold) return "pos-hold-lost";
    if (!fc.armed) return "disarmed";
    if (fc.rxFailsafe) return "rx-failsafe";
    if (!fc.gpsFix || fc.numSat < this.config.minSats) return "gps-lost";
    return null;
  }

  private evaluate(): void {
    const fc = this.inputs.fc;
    if (fc && !fc.mspOverride && this.clock.now() - fc.receivedAt <= this.config.maxStatusAgeMs) this.switchSeenOff = true;
    const failure = this.preconditionFailure();
    switch (this.current) {
      case "IDLE":
        if (failure === null && !this.switchSeenOff) {
          // A handover is the SP flipping the switch on while this supervisor watches. A switch
          // already on when the air (re)connects or the link reopens doesn't count.
          if (this.currentReason !== "awaiting-fresh-handover") {
            this.currentReason = "awaiting-fresh-handover";
            this.emit();
          }
        } else if (failure === null) {
          this.transition("HANDED_OVER", "handover");
        } else if (failure !== this.currentReason) {
          // Not a transition: the reason tells the GUI why the SP can't hand over yet.
          this.currentReason = failure;
          this.emit();
        }
        return;
      case "RELEASED":
        // Stays RELEASED, keeping the reason the GUI shows (e.g. the SP took back control), until
        // a fresh handover: the switch seen off since, then on again with every precondition met.
        if (failure === null && this.switchSeenOff) this.transition("HANDED_OVER", "handover");
        return;
      default:
        if (failure !== null) this.transition("RELEASED", failure);
    }
  }

  private transition(next: SupervisorState, reason: string): void {
    const previous = this.current;
    this.current = next;
    this.currentReason = reason;
    if (next === "HANDED_OVER") {
      this.switchSeenOff = false;
      this.lastSeq = null;
      this.appliedSeq = null;
    }
    if (next === "NEUTRAL" || next === "ABORTED") this.output = [...CENTER];
    if (next === "IDLE" || next === "RELEASED") this.maskCheckDeadline = null;

    if (SENDING_STATES.has(next)) {
      if (!SENDING_STATES.has(previous)) {
        this.lastTickAt = this.clock.now();
        this.lastFrameAt = this.clock.now();
        this.ticker = this.clock.setInterval(() => this.tick(), 1_000 / this.config.commandRateHz);
      }
      this.armWatchdog();
      this.emit();
      if (this.current === next) this.sendFrame();
      return;
    }
    this.stopTicker();
    this.armWatchdog();
    this.emit();
  }

  /** (Re)arms the one-shot timer for the current state's heartbeat deadline; clears it otherwise. */
  private armWatchdog(): void {
    this.clock.clearTimeout(this.watchdog);
    this.watchdog = null;
    if (!SENDING_STATES.has(this.current)) return;
    const timeout = this.current === "ACTIVE" ? this.config.neutralTimeoutMs : this.config.releaseTimeoutMs;
    const due = Math.max(0, timeout - (this.clock.now() - this.lastCommandAt));
    this.watchdog = this.clock.setTimeout(() => {
      this.watchdog = null;
      if (this.releaseIfStalled()) return;
      this.evaluate();
      if (SENDING_STATES.has(this.current) && !this.checkHeartbeat()) this.armWatchdog();
    }, due);
  }

  /**
   * While sending: if the air itself stalled for longer than Betaflight's stale-override window,
   * the FC already flies the SP's sticks again. Resuming would take them back from the SP, so
   * release instead (SITL drill #89, scenario 5). True if it released.
   */
  private releaseIfStalled(): boolean {
    // Callers only run while sending (command in a sending state, the ticker, the watchdog).
    if (this.clock.now() - this.lastFrameAt <= this.config.frameGapReleaseMs) return false;
    this.transition("RELEASED", "air-stalled");
    return true;
  }

  /** NEUTRAL after the neutral timeout, RELEASED after the release timeout; true if it transitioned. */
  private checkHeartbeat(): boolean {
    const silentFor = this.clock.now() - this.lastCommandAt;
    if (this.current === "ACTIVE" && silentFor >= this.config.neutralTimeoutMs) {
      this.transition("NEUTRAL", "heartbeat-lost");
      return true;
    }
    if ((this.current === "NEUTRAL" || this.current === "ABORTED") && silentFor >= this.config.releaseTimeoutMs) {
      this.transition("RELEASED", "heartbeat-lost");
      return true;
    }
    return false;
  }

  private stopTicker(): void {
    this.clock.clearInterval(this.ticker);
    this.ticker = null;
  }

  // --- the 20 Hz command stream ---------------------------------------------

  private tick(): void {
    if (this.releaseIfStalled()) return;
    this.evaluate();
    if (!SENDING_STATES.has(this.current)) return;
    if (this.checkHeartbeat()) return;
    this.checkOverrideMask();
    if (SENDING_STATES.has(this.current)) this.sendFrame();
  }

  private sendFrame(): void {
    const now = this.clock.now();
    if (this.current === "ACTIVE") {
      const period = 1_000 / this.config.commandRateHz;
      const elapsed = Math.min(now - this.lastTickAt, 2 * period);
      const maxStep = (2 * elapsed) / this.config.slewFullRangeMs;
      this.output = this.output.map((value, axis) => value + clamp(this.target[axis] - value, -maxStep, maxStep)) as Axes;
    } else {
      this.output = [...CENTER];
    }
    this.lastTickAt = now;

    const identity = this.inputs.identity!;
    const { roll, pitch, yaw, throttle } = this.config.maxDeflectionUs;
    const values: Axes = [
      STICK_CENTER_US + Math.round(this.output[0] * roll),
      STICK_CENTER_US + Math.round(this.output[1] * pitch),
      STICK_CENTER_US + Math.round(this.output[2] * yaw),
      identity.hoverThrottleUs + Math.round(this.output[3] * throttle),
    ];
    const raw = [0, 0, 0, 0];
    values.forEach((value, axis) => {
      raw[identity.rxMap[axis]] = value;
    });
    this.lastFrameAt = now;
    this.sentFrames.push({ at: now, values });
    if (this.sentFrames.length > MASK_HISTORY) this.sentFrames.shift();
    this.framesSent++;
    this.sink(raw);
  }

  /**
   * ARCHITECTURE.md 7.5 step 8: msp_override_channels_mask isn't readable over MSP, so after
   * unlock each stick channel must be seen following the override in MSP_RC.
   */
  private checkOverrideMask(): void {
    if (this.maskCheckDeadline === null || !SENDING_STATES.has(this.current)) return;
    const rc = this.inputs.fc?.rc;
    const firstFrame = this.sentFrames[0];
    if (rc && firstFrame && rc.receivedAt > firstFrame.at && rc.channels.length >= 4) {
      const tolerance = this.config.maskCheckToleranceUs;
      const followed = this.sentFrames.some(
        (frame) => frame.at < rc.receivedAt && frame.values.every((value, axis) => Math.abs(rc.channels[axis] - value) <= tolerance),
      );
      if (followed) {
        this.maskCheckDeadline = null;
        return;
      }
    }
    if (this.clock.now() >= this.maskCheckDeadline) this.transition("RELEASED", "override-mask-mismatch");
  }

  private emit(): void {
    const snapshot = this.snapshot;
    for (const listener of this.listeners) listener(snapshot);
  }
}
