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
import {
  DEFAULT_SUPERVISOR_CONFIG,
  FlightControlSupervisor,
  type SupervisorConfig,
  type SupervisorFcState,
} from "./FlightControlSupervisor.js";

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
  supervisorConfig?: Partial<SupervisorConfig>;
}

function limitsOf(config: SupervisorConfig): Omit<FlightControlLimits, "hoverThrottleUs"> {
  const { commandRateHz, neutralTimeoutMs, releaseTimeoutMs, maxDeflectionUs } = config;
  return { commandRateHz, neutralTimeoutMs, releaseTimeoutMs, maxDeflectionUs: { ...maxDeflectionUs } };
}

export const DEFAULT_FLIGHT_CONTROL_LIMITS = limitsOf(DEFAULT_SUPERVISOR_CONFIG);

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
    sticksUs: t.rc && t.rc.channels.length >= 4 ? [t.rc.channels[0], t.rc.channels[1], t.rc.channels[2], t.rc.channels[3]] : null,
  };
}

/** The supervisor's view of the FC; null until a status reply has arrived. */
export function toSupervisorFcState(t: Readonly<FcTelemetry>): SupervisorFcState | null {
  if (!t.status) return null;
  return {
    receivedAt: t.status.receivedAt,
    armed: t.status.armed,
    posHold: t.status.activeBoxes.has(BoxId.POSHOLD),
    mspOverride: t.status.activeBoxes.has(BoxId.MSP_OVERRIDE),
    rxFailsafe: t.status.rxFailsafe,
    gpsFix: t.rawGps?.fix ?? false,
    numSat: t.rawGps?.numSat ?? 0,
    rc: t.rc ? { channels: t.rc.channels, receivedAt: t.rc.receivedAt } : null,
  };
}

/**
 * Air-side flight-control composition (ARCHITECTURE.md 7.3, 7.6 and 7.7): owns the opt-in
 * setting and the safety supervisor, follows the current FcLink, routes the ground's fc-command /
 * fc-control / fc-setting, and reports fc-state on the flight-control channel periodically and on
 * every change.
 */
export class FlightControlController {
  private readonly session: FlightControlSessionPort;
  private readonly settings: FlightControlSettingsStore;
  private readonly clock: Clock;
  private readonly reportIntervalMs: number;
  private readonly limits: Omit<FlightControlLimits, "hoverThrottleUs">;
  private readonly supervisor: FlightControlSupervisor;
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
    this.supervisor = new FlightControlSupervisor({
      clock: this.clock,
      config: options.supervisorConfig,
      // FcLink refuses anything outside control mode with a verified FC, a second guard.
      sendRc: (raw) => void this.link?.sendRc(raw),
    });
    this.limits = limitsOf({ ...DEFAULT_SUPERVISOR_CONFIG, ...options.supervisorConfig });
    this.supervisor.update({
      flightControlEnabled: this.settings.isEnabled(),
      channelOpen: this.session.flightControlChannelOpen,
      pageVisible: true,
    });
    this.supervisor.onChange((snapshot) => {
      if (snapshot.reason === "override-mask-mismatch") this.link?.forceTransparent("override-mask-mismatch");
      this.publish();
    });
    this.session.setFlightControlHandler((message) => this.handleGroundMessage(message));
    this.unsubscribeChannel = this.session.onFlightControlChannelChange((open) => this.handleChannel(open));
    if (this.session.flightControlChannelOpen) this.handleChannel(true);
  }

  get flightControlEnabled(): boolean {
    return this.settings.isEnabled();
  }

  get supervisorState(): SupervisorState {
    return this.supervisor.state;
  }

  /** The air page's visibility (visibilitychange / pagehide); hidden releases control. */
  setPageVisible(visible: boolean): void {
    this.supervisor.update({ pageVisible: visible });
  }

  /** Follow a newly opened FC link, or null once it has closed. */
  attachLink(link: FcLink | null): void {
    this.unsubscribeLink?.();
    this.unsubscribeLink = null;
    const previous = this.link;
    this.link = link;
    if (link) {
      this.supervisor.reset("fc-link-opened");
      link.setFlightControlEnabled(this.settings.isEnabled());
      this.unsubscribeLink = link.onChange((event) => {
        if (event === "closed") {
          this.attachLink(null);
          return;
        }
        this.feedSupervisor();
        // Telemetry arrives at the poller's rate; the periodic report carries it.
        if (event !== "telemetry") this.publish();
      });
    } else if (previous) {
      this.feedSupervisor(); // releases if the closed link was in use
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
      // The supervisor releases first, so no frame is queued when the link returns to passthrough.
      this.supervisor.update({ flightControlEnabled: enabled });
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
      supervisor: this.supervisor.snapshot,
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
    this.supervisor.dispose();
  }

  private handleGroundMessage(message: FlightControlGroundMessage): void {
    switch (message.type) {
      case "fc-setting":
        this.setFlightControlEnabled(message.flightControlEnabled, "ground");
        return;
      case "fc-control":
        this.supervisor.handleControl(message.action);
        return;
      case "fc-command":
        this.supervisor.handleCommand(message);
        return;
    }
  }

  private feedSupervisor(): void {
    const link = this.link;
    const result = link?.identification;
    const identity = link && link.mode === "control" && result!.mode === "verified" ? result!.identity : null;
    this.supervisor.update({
      identity: identity ? { hoverThrottleUs: identity.hoverThrottleUs, rxMap: identity.rxMap } : null,
      fcLinkHealthy: link?.healthy ?? false,
      fc: link ? toSupervisorFcState(link.telemetry) : null,
    });
  }

  private handleChannel(open: boolean): void {
    this.supervisor.update({ channelOpen: open });
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
