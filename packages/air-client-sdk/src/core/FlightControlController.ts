import type {
  FlightControlGroundMessage,
  FlightControlLimits,
  FlightControlState,
  FlightControlTelemetry,
  FlightModeName,
  SupervisorState,
} from "@dronelink/core-transport";
import { BoxId } from "@dronelink/fc-msp";
import { systemClock, type Clock } from "./Clock.js";
import type { FcLink, FcTelemetry } from "./FcLink.js";
import type { FlightControlSettingsStore } from "./FlightControlSettingsStore.js";

/** The slice of WebRtcSessionManager the controller needs. */
export interface FlightControlSessionPort {
  readonly flightControlChannelOpen: boolean;
  readonly rejectedFlightControlMessages: number;
  sendFlightControlState(state: FlightControlState): boolean;
  setFlightControlHandler(handler: ((message: FlightControlGroundMessage) => void) | null): void;
  onFlightControlChannelChange(listener: (open: boolean) => void): () => void;
}

export interface FlightControlControllerOptions {
  session: FlightControlSessionPort;
  settings: FlightControlSettingsStore;
  clock?: Clock;
  /** Periodic fc-state rate while the channel is open (5–10 Hz per ARCHITECTURE.md 7.6). */
  reportIntervalMs?: number;
  limits?: Omit<FlightControlLimits, "hoverThrottleUs">;
}

export const DEFAULT_FLIGHT_CONTROL_LIMITS: Omit<FlightControlLimits, "hoverThrottleUs"> = {
  commandRateHz: 20,
  neutralTimeoutMs: 250,
  releaseTimeoutMs: 1_000,
  maxDeflectionUs: { roll: 150, pitch: 150, yaw: 150, throttle: 150 },
};

const MODE_NAMES: readonly [number, FlightModeName][] = [
  [BoxId.ANGLE, "ANGLE"],
  [BoxId.HORIZON, "HORIZON"],
  [BoxId.ALTHOLD, "ALTHOLD"],
  [BoxId.POSHOLD, "POSHOLD"],
  [BoxId.MSP_OVERRIDE, "MSP_OVERRIDE"],
  [BoxId.FAILSAFE, "FAILSAFE"],
  [BoxId.GPSRESCUE, "GPSRESCUE"],
];

/** fc-state telemetry from the poller's latest values; null until a status reply has arrived. */
export function toFlightControlTelemetry(t: Readonly<FcTelemetry>): FlightControlTelemetry | null {
  if (!t.status) return null;
  const gps = t.rawGps;
  return {
    armed: t.status.armed,
    modes: MODE_NAMES.filter(([boxId]) => t.status!.activeBoxes.has(boxId)).map(([, name]) => name),
    rxFailsafe: t.status.rxFailsafe,
    gps: {
      fix: gps?.fix ?? false,
      numSat: gps?.numSat ?? 0,
      latitude: gps?.fix ? gps.latitude : null,
      longitude: gps?.fix ? gps.longitude : null,
    },
    altitudeM: t.altitude?.altitudeM ?? null,
    varioMS: t.altitude?.varioMS ?? null,
    headingDeg: t.attitude?.headingDeg ?? null,
    rollDeg: t.attitude?.rollDeg ?? null,
    pitchDeg: t.attitude?.pitchDeg ?? null,
    voltageV: t.analog?.voltageV ?? null,
  };
}

/**
 * Air-side flight-control composition (ARCHITECTURE.md 7.3 and 7.6): owns the opt-in setting,
 * follows the current FcLink, handles fc-setting from the ground, and reports fc-state on the
 * flight-control channel periodically and on every change.
 */
export class FlightControlController {
  private readonly session: FlightControlSessionPort;
  private readonly settings: FlightControlSettingsStore;
  private readonly clock: Clock;
  private readonly reportIntervalMs: number;
  private readonly limits: Omit<FlightControlLimits, "hoverThrottleUs">;
  private readonly listeners = new Set<(state: FlightControlState) => void>();
  private link: FcLink | null = null;
  private unsubscribeLink: (() => void) | null = null;
  private readonly unsubscribeChannel: () => void;
  private reportTimer: unknown = null;
  private disposed = false;

  constructor(options: FlightControlControllerOptions) {
    this.session = options.session;
    this.settings = options.settings;
    this.clock = options.clock ?? systemClock;
    this.reportIntervalMs = options.reportIntervalMs ?? 200;
    this.limits = options.limits ?? DEFAULT_FLIGHT_CONTROL_LIMITS;
    this.session.setFlightControlHandler((message) => this.handleGroundMessage(message));
    this.unsubscribeChannel = this.session.onFlightControlChannelChange((open) => this.handleChannel(open));
    if (this.session.flightControlChannelOpen) this.handleChannel(true);
  }

  get flightControlEnabled(): boolean {
    return this.settings.isEnabled();
  }

  get supervisorState(): SupervisorState {
    return "IDLE";
  }

  /** Follow a newly opened FC link, or null once it has closed. */
  attachLink(link: FcLink | null): void {
    this.unsubscribeLink?.();
    this.unsubscribeLink = null;
    this.link = link;
    if (link) {
      link.setFlightControlEnabled(this.settings.isEnabled());
      this.unsubscribeLink = link.onChange((event) => {
        if (event === "closed") {
          this.attachLink(null);
          return;
        }
        // Telemetry arrives at the poller's rate; the periodic report carries it.
        if (event !== "telemetry") this.publish();
      });
    }
    this.publish();
  }

  /**
   * Changes the opt-in setting. Changes from the ground are only accepted while the
   * supervisor is IDLE or RELEASED; turning it off from the air is always accepted.
   */
  setFlightControlEnabled(enabled: boolean, source: "air" | "ground" = "air"): boolean {
    if (source === "ground" && !["IDLE", "RELEASED"].includes(this.supervisorState)) return false;
    if (enabled !== this.settings.isEnabled()) {
      this.settings.setEnabled(enabled);
      this.link?.setFlightControlEnabled(enabled);
    }
    this.publish();
    return true;
  }

  onStateChange(listener: (state: FlightControlState) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  buildState(): FlightControlState {
    const link = this.link;
    const result = link?.identification ?? null;
    const identity = result?.identity ?? null;
    return {
      type: "fc-state",
      sentAt: this.clock.now(),
      flightControlEnabled: this.settings.isEnabled(),
      link: link
        ? { mode: result!.mode, reason: result!.reason, detectedType: link.detectedType }
        : { mode: "transparent", reason: "no-fc-link", detectedType: "silent" },
      fc: identity
        ? { variant: identity.variant, version: identity.version, apiVersion: identity.apiVersion, board: identity.board }
        : null,
      supervisor: { state: this.supervisorState, reason: null, lastAppliedSeq: null },
      telemetry: link ? toFlightControlTelemetry(link.telemetry) : null,
      limits: { ...this.limits, hoverThrottleUs: identity?.hoverThrottleUs ?? null },
      rejectedMessages: this.session.rejectedFlightControlMessages,
    };
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.unsubscribeLink?.();
    this.unsubscribeChannel();
    this.session.setFlightControlHandler(null);
    this.clock.clearInterval(this.reportTimer);
  }

  private handleGroundMessage(message: FlightControlGroundMessage): void {
    if (message.type === "fc-setting") {
      this.setFlightControlEnabled(message.flightControlEnabled, "ground");
      return;
    }
    // fc-command / fc-control are the supervisor's (#86). Without one, nothing reaches the FC.
  }

  private handleChannel(open: boolean): void {
    this.clock.clearInterval(this.reportTimer);
    this.reportTimer = null;
    if (open) {
      this.reportTimer = this.clock.setInterval(() => this.publish(), this.reportIntervalMs);
    }
    this.publish();
  }

  private publish(): void {
    if (this.disposed) return;
    const state = this.buildState();
    this.session.sendFlightControlState(state);
    for (const listener of this.listeners) listener(state);
  }
}
