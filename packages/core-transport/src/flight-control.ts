/**
 * Flight-control messages (ARCHITECTURE.md section 7.6), shared by the air side, the ground
 * relay and the ground GUI. JSON over the dedicated "flight-control" RTCDataChannel between
 * air and ground, and over the GUI's signaling WebSocket between ground and GUI.
 *
 * Wire contract: protocol/schemas/flight-control-command.schema.json (ground -> air) and
 * flight-control-state.schema.json (air -> ground, plus the ground's fc-channel notice).
 * The parsers below accept exactly what those schemas accept; the tests check them against
 * the schemas.
 *
 * The channel is unordered and never retransmits, so a lost message is simply gone:
 * fc-command is a 20 Hz stream (the newest wins, older seqs are dropped), and fc-control /
 * fc-setting are idempotent, so the GUI resends them until the air's fc-state confirms.
 */

export const FLIGHT_CONTROL_CHANNEL_LABEL = "flight-control";
export const FLIGHT_CONTROL_CHANNEL_INIT = { ordered: false, maxRetransmits: 0 } as const;

export type FlightControlAction = "unlock" | "abort" | "release";

export interface FlightControlCommand {
  type: "fc-command";
  /** Strictly increasing per GUI session; the air drops anything not newer than the last. */
  seq: number;
  /** Ground wall-clock time in ms, for diagnostics; air timeouts use its own clock. */
  sentAt: number;
  /** Stick deflections in [-1, 1] around neutral (1500 µs; hover throttle for throttle). */
  roll: number;
  pitch: number;
  yaw: number;
  throttle: number;
}

export interface FlightControlActionMessage {
  type: "fc-control";
  action: FlightControlAction;
}

export interface FlightControlSettingMessage {
  type: "fc-setting";
  flightControlEnabled: boolean;
}

export type FlightControlGroundMessage = FlightControlCommand | FlightControlActionMessage | FlightControlSettingMessage;

export type SupervisorState = "IDLE" | "HANDED_OVER" | "ACTIVE" | "NEUTRAL" | "ABORTED" | "RELEASED";
export type FcLinkMode = "transparent" | "pending" | "verified";
export type DetectedLinkType = "msp-v1" | "msp-v2" | "mavlink-v1" | "mavlink-v2" | "crsf" | "unknown" | "silent";
export type FlightModeName = "ANGLE" | "HORIZON" | "ALTHOLD" | "POSHOLD" | "MSP_OVERRIDE" | "FAILSAFE" | "GPSRESCUE";

export interface FlightControlTelemetry {
  armed: boolean;
  modes: FlightModeName[];
  rxFailsafe: boolean;
  gps: { fix: boolean; numSat: number; latitude: number | null; longitude: number | null };
  altitudeM: number | null;
  varioMS: number | null;
  headingDeg: number | null;
  rollDeg: number | null;
  pitchDeg: number | null;
  voltageV: number | null;
  /**
   * The sticks the FC is flying right now (MSP_RC: roll, pitch, yaw, throttle in µs): the SP's
   * while the override isn't applied, the phone's while it is. Shows on the bench whose sticks
   * the FC follows (docs/flight/sp-pp-procedure.md).
   */
  sticksUs: [number, number, number, number] | null;
}

export interface FlightControlLimits {
  commandRateHz: number;
  neutralTimeoutMs: number;
  releaseTimeoutMs: number;
  /** The FC's ap_hover_throttle, the throttle neutral; null until identified. */
  hoverThrottleUs: number | null;
  maxDeflectionUs: { roll: number; pitch: number; yaw: number; throttle: number };
}

export interface FlightControlState {
  type: "fc-state";
  /** Air wall-clock time in ms. */
  sentAt: number;
  flightControlEnabled: boolean;
  link: { mode: FcLinkMode; reason: string | null; detectedType: DetectedLinkType };
  fc: { variant: string; version: string; apiVersion: string; board: string } | null;
  supervisor: { state: SupervisorState; reason: string | null; lastAppliedSeq: number | null };
  telemetry: FlightControlTelemetry | null;
  limits: FlightControlLimits;
  /** Ground messages the air rejected as invalid since the session started. */
  rejectedMessages: number;
}

/** Sent by the ground runtime to the GUI when the air's flight-control channel opens or closes. */
export interface FlightControlChannelStatus {
  type: "fc-channel";
  open: boolean;
}

export type FlightControlAirMessage = FlightControlState | FlightControlChannelStatus;

const FLIGHT_CONTROL_ACTIONS: readonly FlightControlAction[] = ["unlock", "abort", "release"];
const SUPERVISOR_STATES: readonly SupervisorState[] = ["IDLE", "HANDED_OVER", "ACTIVE", "NEUTRAL", "ABORTED", "RELEASED"];
const LINK_MODES: readonly FcLinkMode[] = ["transparent", "pending", "verified"];
const LINK_TYPES: readonly DetectedLinkType[] = ["msp-v1", "msp-v2", "mavlink-v1", "mavlink-v2", "crsf", "unknown", "silent"];
const FLIGHT_MODES: readonly FlightModeName[] = ["ANGLE", "HORIZON", "ALTHOLD", "POSHOLD", "MSP_OVERRIDE", "FAILSAFE", "GPSRESCUE"];

type Json = Record<string, unknown>;

function isObject(value: unknown): value is Json {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** additionalProperties: false with every listed key required. */
function hasExactly(value: unknown, keys: readonly string[]): value is Json {
  if (!isObject(value)) return false;
  const actual = Object.keys(value);
  return actual.length === keys.length && keys.every((key) => key in value);
}

const isNumber = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const isNonNegative = (v: unknown): v is number => isNumber(v) && v >= 0;
const isCount = (v: unknown): v is number => Number.isSafeInteger(v) && (v as number) >= 0;
const isAxis = (v: unknown) => isNumber(v) && v >= -1 && v <= 1;
const isNullableNumber = (v: unknown) => v === null || isNumber(v);
const isNullableString = (v: unknown) => v === null || typeof v === "string";
const isOneOf = <T extends string>(options: readonly T[], v: unknown): v is T =>
  typeof v === "string" && (options as readonly string[]).includes(v);

/** Validates a ground -> air message; null when it doesn't match the command schema. */
export function parseFlightControlGroundMessage(value: unknown): FlightControlGroundMessage | null {
  if (!isObject(value)) return null;
  switch (value.type) {
    case "fc-command":
      return hasExactly(value, ["type", "seq", "sentAt", "roll", "pitch", "yaw", "throttle"]) &&
        isCount(value.seq) &&
        isNonNegative(value.sentAt) &&
        [value.roll, value.pitch, value.yaw, value.throttle].every(isAxis)
        ? (value as unknown as FlightControlCommand)
        : null;
    case "fc-control":
      return hasExactly(value, ["type", "action"]) && isOneOf(FLIGHT_CONTROL_ACTIONS, value.action)
        ? (value as unknown as FlightControlActionMessage)
        : null;
    case "fc-setting":
      return hasExactly(value, ["type", "flightControlEnabled"]) && typeof value.flightControlEnabled === "boolean"
        ? (value as unknown as FlightControlSettingMessage)
        : null;
    default:
      return null;
  }
}

function isTelemetry(v: unknown): boolean {
  if (
    !hasExactly(v, ["armed", "modes", "rxFailsafe", "gps", "altitudeM", "varioMS", "headingDeg", "rollDeg", "pitchDeg", "voltageV", "sticksUs"])
  ) {
    return false;
  }
  const gps = v.gps;
  return (
    typeof v.armed === "boolean" &&
    Array.isArray(v.modes) &&
    v.modes.every((mode) => isOneOf(FLIGHT_MODES, mode)) &&
    new Set(v.modes).size === v.modes.length &&
    typeof v.rxFailsafe === "boolean" &&
    hasExactly(gps, ["fix", "numSat", "latitude", "longitude"]) &&
    typeof gps.fix === "boolean" &&
    isCount(gps.numSat) &&
    isNullableNumber(gps.latitude) &&
    isNullableNumber(gps.longitude) &&
    [v.altitudeM, v.varioMS, v.headingDeg, v.rollDeg, v.pitchDeg, v.voltageV].every(isNullableNumber) &&
    (v.sticksUs === null || (Array.isArray(v.sticksUs) && v.sticksUs.length === 4 && v.sticksUs.every(isNumber)))
  );
}

function isLimits(v: unknown): boolean {
  if (!hasExactly(v, ["commandRateHz", "neutralTimeoutMs", "releaseTimeoutMs", "hoverThrottleUs", "maxDeflectionUs"])) {
    return false;
  }
  const deflection = v.maxDeflectionUs;
  return (
    isNumber(v.commandRateHz) &&
    v.commandRateHz > 0 &&
    isNonNegative(v.neutralTimeoutMs) &&
    isNonNegative(v.releaseTimeoutMs) &&
    (v.hoverThrottleUs === null || isCount(v.hoverThrottleUs)) &&
    hasExactly(deflection, ["roll", "pitch", "yaw", "throttle"]) &&
    [deflection.roll, deflection.pitch, deflection.yaw, deflection.throttle].every(isCount)
  );
}

function isFlightControlState(v: Json): boolean {
  if (
    !hasExactly(v, ["type", "sentAt", "flightControlEnabled", "link", "fc", "supervisor", "telemetry", "limits", "rejectedMessages"])
  ) {
    return false;
  }
  const { link, fc, supervisor } = v;
  return (
    isNonNegative(v.sentAt) &&
    typeof v.flightControlEnabled === "boolean" &&
    hasExactly(link, ["mode", "reason", "detectedType"]) &&
    isOneOf(LINK_MODES, link.mode) &&
    isNullableString(link.reason) &&
    isOneOf(LINK_TYPES, link.detectedType) &&
    (fc === null ||
      (hasExactly(fc, ["variant", "version", "apiVersion", "board"]) &&
        [fc.variant, fc.version, fc.apiVersion, fc.board].every((s) => typeof s === "string"))) &&
    hasExactly(supervisor, ["state", "reason", "lastAppliedSeq"]) &&
    isOneOf(SUPERVISOR_STATES, supervisor.state) &&
    isNullableString(supervisor.reason) &&
    (supervisor.lastAppliedSeq === null || isCount(supervisor.lastAppliedSeq)) &&
    (v.telemetry === null || isTelemetry(v.telemetry)) &&
    isLimits(v.limits) &&
    isCount(v.rejectedMessages)
  );
}

/** Validates an air -> ground (or ground -> GUI) message; null when it doesn't match the state schema. */
export function parseFlightControlAirMessage(value: unknown): FlightControlAirMessage | null {
  if (!isObject(value)) return null;
  if (value.type === "fc-channel") {
    return hasExactly(value, ["type", "open"]) && typeof value.open === "boolean"
      ? (value as unknown as FlightControlChannelStatus)
      : null;
  }
  if (value.type === "fc-state") {
    return isFlightControlState(value) ? (value as unknown as FlightControlState) : null;
  }
  return null;
}
