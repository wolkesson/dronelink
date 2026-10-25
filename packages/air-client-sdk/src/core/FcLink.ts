import type { DetectedLinkType } from "@dronelink/core-transport";
import {
  BoxId,
  MspCommand,
  MspParser,
  activeBoxIds,
  decodeAltitude,
  decodeAnalog,
  decodeAttitude,
  decodeCompGps,
  decodeRawGps,
  decodeRc,
  decodeStatus,
  encodeMspRequest,
  encodeSetRawRc,
  type Altitude,
  type Analog,
  type Attitude,
  type CompGps,
  type FcStatus,
  type RawGps,
} from "@dronelink/fc-msp";
import type { SerialTransport } from "../transport/SerialTransport.js";
import { systemClock, type Clock } from "./Clock.js";
import { FcIdentificationGate, type IdentificationResult } from "./FcIdentificationGate.js";
import { LinkTypeClassifier } from "./LinkTypeClassifier.js";

/**
 * - passthrough: today's opaque serial-relay, byte-identical in both directions.
 * - identifying: the gate's probes own the link; FC bytes are consumed, ground bytes are held.
 * - control: the air side owns the link (MSP_SET_RAW_RC + telemetry); passthrough is suspended.
 */
export type FcLinkMode = "passthrough" | "identifying" | "control";

export type FcLinkEvent = "mode" | "identification" | "telemetry" | "health" | "closed";

export type Stamped<T> = T & { receivedAt: number };

export interface FcStatusTelemetry extends FcStatus {
  armed: boolean;
  /** Permanent box ids (BoxId) that are currently active. */
  activeBoxes: ReadonlySet<number>;
  rxFailsafe: boolean;
}

export interface FcTelemetry {
  status: Stamped<FcStatusTelemetry> | null;
  /** rcData in Betaflight's internal order R, P, Y, T, AUX1.. (after MSP override). */
  rc: Stamped<{ channels: number[] }> | null;
  rawGps: Stamped<RawGps> | null;
  compGps: Stamped<CompGps> | null;
  attitude: Stamped<Attitude> | null;
  altitude: Stamped<Altitude> | null;
  analog: Stamped<Analog> | null;
}

export interface FcLinkConfig {
  /** No ground->FC bytes for this long before active identification may start. */
  passthroughIdleMs: number;
  /** No MSP reply for this long in control mode -> fc-link-lost. */
  linkHealthTimeoutMs: number;
  /** One telemetry request per interval at most (the serial budget). */
  telemetryIntervalMs: number;
  /** An unanswered telemetry request is given up after this long. */
  telemetryRequestTimeoutMs: number;
  /** A probe reply that doesn't arrive within this long counts as a timeout. */
  probeTimeoutMs: number;
  /** Probe replies still in flight when identification is cancelled are swallowed for this long. */
  probeGuardMs: number;
  /** Ground bytes held while identification winds down; anything beyond is dropped and counted. */
  maxHeldGroundBytes: number;
  /** How often silence detection and identification scheduling are re-evaluated. */
  housekeepingIntervalMs: number;
}

export const DEFAULT_FC_LINK_CONFIG: FcLinkConfig = {
  passthroughIdleMs: 2_000,
  linkHealthTimeoutMs: 500,
  telemetryIntervalMs: 20,
  telemetryRequestTimeoutMs: 250,
  probeTimeoutMs: 1_500,
  probeGuardMs: 150,
  maxHeldGroundBytes: 4_096,
  housekeepingIntervalMs: 100,
};

/** Round-robin telemetry, as listed in #85. MSP_STATUS_EX carries the MSP OVERRIDE (handover) box. */
export const TELEMETRY_COMMANDS = [
  MspCommand.STATUS_EX,
  MspCommand.RC,
  MspCommand.ATTITUDE,
  MspCommand.ALTITUDE,
  MspCommand.RAW_GPS,
  MspCommand.COMP_GPS,
  MspCommand.ANALOG,
] as const;

/** Betaflight armingDisableFlags bit ARMING_DISABLED_RX_FAILSAFE. */
const ARMING_DISABLED_RX_FAILSAFE = 1 << 2;
/** The four stick channels; MSP_SET_RAW_RC frames never carry AUX channels. */
export const STICK_CHANNEL_COUNT = 4;

const CONTRADICTS_MSP: ReadonlySet<DetectedLinkType> = new Set(["mavlink-v1", "mavlink-v2", "crsf"]);

export interface FcLinkOptions {
  transport: SerialTransport;
  flightControlEnabled: boolean;
  clock?: Clock;
  gate?: FcIdentificationGate;
  classifier?: LinkTypeClassifier;
  config?: Partial<FcLinkConfig>;
}

interface PendingReply {
  resolve: (payload: Uint8Array | null) => void;
  timeout: unknown;
}

function emptyTelemetry(): FcTelemetry {
  return { status: null, rc: null, rawGps: null, compGps: null, attitude: null, altitude: null, analog: null };
}

/**
 * Arbiter for the air-side FC link (ARCHITECTURE.md section 7.3, issue #85). The one place that
 * decides whether serial bytes are relayed opaquely or the air side speaks MSP itself.
 *
 * Every link (re)open starts in passthrough. Leaving passthrough needs the setting on, plus an
 * idle passthrough for the identification probes, and control mode additionally needs the gate
 * to report `verified`. Turning the setting off, or the gate leaving `verified`, returns to
 * passthrough immediately. A lost-and-recovered FC link in control mode (reboot, brownout,
 * replug through a bridge) is re-identified before control resumes.
 */
export class FcLink {
  private readonly transport: SerialTransport;
  private readonly clock: Clock;
  private readonly gate: FcIdentificationGate;
  private readonly classifier: LinkTypeClassifier;
  private readonly config: FcLinkConfig;
  private readonly parser = new MspParser();
  private readonly groundHandlers = new Set<(bytes: Uint8Array) => void>();
  private readonly listeners = new Set<(event: FcLinkEvent) => void>();
  private readonly pending = new Map<number, PendingReply[]>();

  private enabled: boolean;
  private currentMode: FcLinkMode = "passthrough";
  private started = false;
  private closed = false;
  private unsubscribe: (() => void) | null = null;
  private housekeeping: unknown = null;
  private poller: unknown = null;
  private guardTimer: unknown = null;
  private lastGroundByteAt: number | null = null;
  private lastReplyAt: number | null = null;
  private linkHealthy = true;
  private identifying = false;
  private identifyRun = 0;
  private cancelling = false;
  private probeInFlight = false;
  private heldGroundBytes: Uint8Array[] = [];
  private heldGroundLength = 0;
  private droppedGround = 0;
  private telemetryIndex = 0;
  private telemetryInFlight = false;
  private rcFrame: Uint8Array | null = null;
  private writeQueue: Uint8Array[] = [];
  private writing = false;
  private rcFramesWritten = 0;
  private readonly currentTelemetry: FcTelemetry = emptyTelemetry();

  constructor(options: FcLinkOptions) {
    this.transport = options.transport;
    this.enabled = options.flightControlEnabled;
    this.clock = options.clock ?? systemClock;
    this.gate = options.gate ?? new FcIdentificationGate();
    this.classifier = options.classifier ?? new LinkTypeClassifier();
    this.config = { ...DEFAULT_FC_LINK_CONFIG, ...options.config };
  }

  get mode(): FcLinkMode {
    return this.currentMode;
  }

  get detectedType(): DetectedLinkType {
    return this.classifier.detectedType;
  }

  get identification(): IdentificationResult {
    return this.gate.result;
  }

  get flightControlEnabled(): boolean {
    return this.enabled;
  }

  /** Control mode only: an MSP reply arrived within the health timeout. */
  get healthy(): boolean {
    return this.currentMode === "control" && this.linkHealthy;
  }

  get telemetry(): Readonly<FcTelemetry> {
    return this.currentTelemetry;
  }

  /** Ground->FC bytes dropped because the air side owned the link. */
  get droppedGroundBytes(): number {
    return this.droppedGround;
  }

  get rcFramesSent(): number {
    return this.rcFramesWritten;
  }

  /** Call once, after the transport has opened. */
  start(): void {
    if (this.started) return;
    this.started = true;
    this.gate.reset("link-opened");
    // The idle window also runs from link open, so a Configurator that connects right after
    // the FC is plugged in is never interleaved with probes.
    this.lastGroundByteAt = this.clock.now();
    this.classifier.begin(this.lastGroundByteAt);
    this.unsubscribe = this.transport.subscribe((bytes) => this.receiveFromFc(bytes));
    this.housekeeping = this.clock.setInterval(() => this.runHousekeeping(), this.config.housekeepingIntervalMs);
    this.runHousekeeping();
  }

  /** Stops everything; the link counts as closed afterwards. Does not close the transport. */
  stop(): void {
    if (!this.started || this.closed) return;
    this.closed = true;
    this.unsubscribe?.();
    this.unsubscribe = null;
    this.clock.clearInterval(this.housekeeping);
    this.stopControl();
    this.clock.clearTimeout(this.guardTimer);
    this.gate.reset("link-closed");
    this.rejectAllPending();
    this.heldGroundBytes = [];
    this.heldGroundLength = 0;
    this.setMode("passthrough");
    this.emit("closed");
  }

  /** FC->ground bytes to relay. Only called in passthrough, with the chunks exactly as read. */
  onGroundBound(handler: (bytes: Uint8Array) => void): () => void {
    this.groundHandlers.add(handler);
    return () => {
      this.groundHandlers.delete(handler);
    };
  }

  onChange(listener: (event: FcLinkEvent) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /** Ground->FC bytes from the serial-relay channel. */
  writeFromGround(bytes: Uint8Array): void {
    if (this.closed || bytes.length === 0) return;
    this.lastGroundByteAt = this.clock.now();
    switch (this.currentMode) {
      case "passthrough":
        this.transport.write(bytes).catch(() => undefined);
        return;
      case "identifying":
        this.holdGroundBytes(bytes);
        if (!this.cancelling) this.cancelIdentification();
        return;
      case "control":
        this.droppedGround += bytes.length;
        return;
    }
  }

  setFlightControlEnabled(enabled: boolean): void {
    if (enabled === this.enabled) return;
    this.enabled = enabled;
    if (enabled) {
      this.runHousekeeping();
      return;
    }
    this.gate.disable();
    this.emit("identification");
    if (this.currentMode === "control") {
      this.stopControl();
      this.setMode("passthrough");
    } else if (this.currentMode === "identifying" && !this.cancelling) {
      this.beginCancel();
    }
  }

  /**
   * Leaves control mode for passthrough with the gate transparent for `reason` (e.g. the
   * supervisor's override-mask check failed). It stays transparent until the link reopens or
   * the setting is toggled.
   */
  forceTransparent(reason: string): void {
    if (this.closed || this.currentMode !== "control") return;
    this.stopControl();
    this.gate.reset(reason);
    this.emit("identification");
    this.setMode("passthrough");
  }

  /**
   * Queues an MSP_SET_RAW_RC frame with the four stick channels in raw receiver order. It is
   * written ahead of any queued telemetry request; a newer frame replaces one not yet written.
   * Refused (false) unless in control mode with a verified FC.
   */
  sendRc(rawChannels: readonly number[]): boolean {
    if (this.currentMode !== "control" || this.gate.result.mode !== "verified") return false;
    if (rawChannels.length !== STICK_CHANNEL_COUNT) {
      throw new RangeError(`MSP_SET_RAW_RC must carry exactly ${STICK_CHANNEL_COUNT} stick channels, got ${rawChannels.length}`);
    }
    this.rcFrame = encodeMspRequest(MspCommand.SET_RAW_RC, encodeSetRawRc(rawChannels));
    void this.drain();
    return true;
  }

  // --- FC -> air ------------------------------------------------------------

  private receiveFromFc(bytes: Uint8Array): void {
    if (this.closed) return;
    if (bytes.length === 0) {
      this.stop();
      return;
    }
    if (this.currentMode === "passthrough") {
      for (const handler of this.groundHandlers) handler(bytes);
      this.classifier.push(bytes, this.clock.now());
      return;
    }
    this.classifier.push(bytes, this.clock.now());
    let gotReply = false;
    for (const frame of this.parser.push(bytes)) {
      if (frame.direction === "request") continue;
      gotReply = true;
      this.lastReplyAt = this.clock.now();
      this.resolvePending(frame.command, frame.direction === "response" ? frame.payload : null);
      if (this.currentMode === "control") this.applyTelemetry(frame.command, frame.direction === "response" ? frame.payload : null);
    }
    if (gotReply && this.currentMode === "control" && !this.linkHealthy) {
      // Replies are back after a loss: the FC may have rebooted or been swapped. Re-identify.
      this.stopControl();
      this.gate.reset("fc-link-recovered");
      void this.identify();
      this.linkHealthy = true;
      this.emit("health");
    }
  }

  private resolvePending(command: number, payload: Uint8Array | null): void {
    const queue = this.pending.get(command);
    const next = queue?.shift();
    if (!next) return;
    if (queue!.length === 0) this.pending.delete(command);
    this.clock.clearTimeout(next.timeout);
    next.resolve(payload);
  }

  private rejectAllPending(): void {
    for (const queue of this.pending.values()) {
      for (const entry of queue) {
        this.clock.clearTimeout(entry.timeout);
        entry.resolve(null);
      }
    }
    this.pending.clear();
  }

  private request(command: number, timeoutMs: number, payload?: Uint8Array): Promise<Uint8Array | null> {
    return new Promise((resolve) => {
      const entry: PendingReply = { resolve, timeout: null };
      entry.timeout = this.clock.setTimeout(() => {
        const queue = this.pending.get(command)!;
        queue.splice(queue.indexOf(entry), 1);
        if (queue.length === 0) this.pending.delete(command);
        resolve(null);
      }, timeoutMs);
      const queue = this.pending.get(command) ?? [];
      queue.push(entry);
      this.pending.set(command, queue);
      this.writeQueue.push(encodeMspRequest(command, payload));
      void this.drain();
    });
  }

  private async drain(): Promise<void> {
    if (this.writing) return;
    this.writing = true;
    try {
      while (!this.closed && (this.rcFrame || this.writeQueue.length > 0)) {
        const isRc = this.rcFrame !== null;
        const frame = this.rcFrame ?? this.writeQueue.shift()!;
        this.rcFrame = null;
        if (isRc && this.currentMode !== "control") continue;
        try {
          await this.transport.write(frame);
          if (isRc) this.rcFramesWritten++;
        } catch {
          // The health watchdog reports a dead link; a failed write needs nothing else.
        }
      }
    } finally {
      this.writing = false;
    }
  }

  // --- identification -----------------------------------------------------

  private runHousekeeping(): void {
    if (this.closed) return;
    const before = this.classifier.detectedType;
    const now = this.clock.now();
    this.classifier.tick(now);
    if (this.classifier.detectedType !== before) this.emit("identification");

    if (this.currentMode !== "passthrough" || !this.enabled || this.identifying) return;
    const result = this.gate.result;
    // A definitive refusal stays until the link reopens or the setting is toggled.
    if (result.mode === "transparent" && !["link-opened", "setting-disabled", "fc-link-recovered"].includes(result.reason)) {
      return;
    }
    if (result.mode === "verified") return;
    if (CONTRADICTS_MSP.has(this.classifier.detectedType)) {
      this.gate.identify({ enabled: true, detectedType: this.classifier.detectedType, passthroughIdle: true, request: async () => null });
      this.emit("identification");
      return;
    }
    const idleSince = this.lastGroundByteAt;
    if (idleSince !== null && now - idleSince < this.config.passthroughIdleMs) {
      if (result.mode !== "pending") {
        void this.gate.identify({ enabled: true, detectedType: this.classifier.detectedType, passthroughIdle: false, request: async () => null });
        this.emit("identification");
      }
      return;
    }
    void this.identify();
  }

  private async identify(): Promise<void> {
    const run = ++this.identifyRun;
    this.identifying = true;
    this.cancelling = false;
    this.parser.reset();
    this.setMode("identifying");
    const pendingResult = this.gate.identify({
      enabled: this.enabled,
      detectedType: this.classifier.detectedType,
      passthroughIdle: true,
      request: (command) => this.probe(command),
    });
    this.emit("identification");
    const result = await pendingResult;
    if (this.closed || run !== this.identifyRun) return;
    this.identifying = false;
    this.emit("identification");
    if (this.cancelling) return; // finishCancel() returns to passthrough once the guard ends
    if (result.mode === "verified" && this.enabled) {
      this.dropHeldGroundBytes();
      this.startControl();
      return;
    }
    this.returnToPassthrough();
  }

  private async probe(command: number): Promise<Uint8Array | null> {
    if (this.cancelling || this.closed) return null;
    this.probeInFlight = true;
    const payload = await this.request(command, this.config.probeTimeoutMs);
    this.probeInFlight = false;
    if (this.cancelling) this.finishCancel();
    return payload;
  }

  private cancelIdentification(): void {
    void this.gate.identify({ enabled: this.enabled, detectedType: this.classifier.detectedType, passthroughIdle: false, request: async () => null });
    this.emit("identification");
    this.beginCancel();
  }

  private beginCancel(): void {
    this.cancelling = true;
    if (!this.probeInFlight) {
      this.finishCancel();
      return;
    }
    this.guardTimer = this.clock.setTimeout(() => this.finishCancel(), this.config.probeGuardMs);
  }

  private finishCancel(): void {
    if (!this.cancelling || this.closed) return;
    this.clock.clearTimeout(this.guardTimer);
    this.guardTimer = null;
    this.identifyRun++;
    this.rejectAllPending();
    this.cancelling = false;
    this.identifying = false;
    this.returnToPassthrough();
  }

  private returnToPassthrough(): void {
    this.setMode("passthrough");
    const held = this.heldGroundBytes;
    this.heldGroundBytes = [];
    this.heldGroundLength = 0;
    for (const bytes of held) this.transport.write(bytes).catch(() => undefined);
  }

  private holdGroundBytes(bytes: Uint8Array): void {
    if (this.heldGroundLength + bytes.length > this.config.maxHeldGroundBytes) {
      this.droppedGround += bytes.length;
      return;
    }
    this.heldGroundBytes.push(bytes);
    this.heldGroundLength += bytes.length;
  }

  private dropHeldGroundBytes(): void {
    this.droppedGround += this.heldGroundLength;
    this.heldGroundBytes = [];
    this.heldGroundLength = 0;
  }

  // --- control mode -------------------------------------------------------

  private startControl(): void {
    this.lastReplyAt = this.clock.now();
    this.linkHealthy = true;
    this.telemetryIndex = 0;
    this.telemetryInFlight = false;
    this.setMode("control");
    this.poller = this.clock.setInterval(() => this.pollTelemetry(), this.config.telemetryIntervalMs);
    this.pollTelemetry();
  }

  private stopControl(): void {
    this.clock.clearInterval(this.poller);
    this.poller = null;
    this.rcFrame = null;
    this.writeQueue = [];
    this.telemetryInFlight = false;
    this.rejectAllPending();
    Object.assign(this.currentTelemetry, emptyTelemetry());
  }

  private pollTelemetry(): void {
    if (this.currentMode !== "control") return;
    this.checkHealth(this.clock.now());
    if (this.telemetryInFlight) return;
    const command = TELEMETRY_COMMANDS[this.telemetryIndex];
    this.telemetryIndex = (this.telemetryIndex + 1) % TELEMETRY_COMMANDS.length;
    this.telemetryInFlight = true;
    void this.request(command, this.config.telemetryRequestTimeoutMs).then(() => {
      this.telemetryInFlight = false;
    });
  }

  private checkHealth(now: number): void {
    if (!this.linkHealthy || this.lastReplyAt === null) return;
    if (now - this.lastReplyAt >= this.config.linkHealthTimeoutMs) {
      this.linkHealthy = false;
      this.emit("health");
    }
  }

  private applyTelemetry(command: number, payload: Uint8Array | null): void {
    if (!payload) return;
    const receivedAt = this.clock.now();
    const identity = this.gate.result.identity;
    const t = this.currentTelemetry;
    try {
      switch (command) {
        case MspCommand.STATUS_EX: {
          const status = decodeStatus(payload);
          const activeBoxes = activeBoxIds(status.flightModeFlags, identity?.boxIds ?? []);
          t.status = {
            ...status,
            activeBoxes,
            armed: activeBoxes.has(BoxId.ARM),
            rxFailsafe: activeBoxes.has(BoxId.FAILSAFE) || (status.armingDisableFlags & ARMING_DISABLED_RX_FAILSAFE) !== 0,
            receivedAt,
          };
          break;
        }
        case MspCommand.RC:
          t.rc = { channels: decodeRc(payload), receivedAt };
          break;
        case MspCommand.ATTITUDE:
          t.attitude = { ...decodeAttitude(payload), receivedAt };
          break;
        case MspCommand.ALTITUDE:
          t.altitude = { ...decodeAltitude(payload), receivedAt };
          break;
        case MspCommand.RAW_GPS:
          t.rawGps = { ...decodeRawGps(payload), receivedAt };
          break;
        case MspCommand.COMP_GPS:
          t.compGps = { ...decodeCompGps(payload), receivedAt };
          break;
        case MspCommand.ANALOG:
          t.analog = { ...decodeAnalog(payload), receivedAt };
          break;
        default:
          return;
      }
    } catch {
      return; // a malformed reply leaves the previous value in place
    }
    this.emit("telemetry");
  }

  // --- helpers ------------------------------------------------------------

  private setMode(mode: FcLinkMode): void {
    if (mode === this.currentMode) return;
    this.currentMode = mode;
    this.emit("mode");
  }

  private emit(event: FcLinkEvent): void {
    for (const listener of this.listeners) listener(event);
  }
}
