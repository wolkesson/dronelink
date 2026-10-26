import type { DetectedLinkType, FlightControlState, SupervisorState } from "@dronelink/core-transport";

/** fc-state older than this is shown grayed out as STALE (issue #87). */
export const STALE_AFTER_MS = 1_000;
/** The ground's RTT gate (ARCHITECTURE.md 7.9): above it the command stream stops. */
export const RTT_GATE_MS = 400;
/** Minimum GPS satellites shown as "go"; the air supervisor enforces its own limit. */
export const MIN_GPS_SATS = 8;

export type Tone = "ok" | "warn" | "danger" | "neutral";

export interface GoNoGoItem {
  key: string;
  label: string;
  ok: boolean;
  detail: string | null;
}

export interface FlightControlView {
  /** No fc-state received yet. */
  noState: boolean;
  stale: boolean;
  stateAgeMs: number | null;
  channelOpen: boolean;
  flightControlEnabled: boolean;
  /** The opt-in setting may only be changed outside an active control state. */
  settingChangeAllowed: boolean;
  linkType: string;
  linkMode: { text: string; tone: Tone };
  fcIdentity: string | null;
  banner: { text: string; tone: Tone } | null;
  supervisor: { state: SupervisorState | null; reason: string | null };
  goNoGo: { go: boolean; items: GoNoGoItem[] };
  telemetry: { label: string; value: string; tone: Tone }[];
}

export interface ViewContext {
  now: number;
  /** When the latest fc-state arrived (local clock), null if none yet. */
  receivedAt: number | null;
  channelOpen: boolean;
  rttMs: number | null;
}

const LINK_TYPE_LABELS: Record<DetectedLinkType, string> = {
  "msp-v1": "MSP v1",
  "msp-v2": "MSP v2",
  "mavlink-v1": "MAVLink v1",
  "mavlink-v2": "MAVLink v2",
  crsf: "CRSF",
  unknown: "Unknown",
  silent: "Silent",
};

const BOX_NAMES: Record<string, string> = { "0": "ARM", "3": "ALTHOLD", "11": "POS HOLD", "50": "MSP OVERRIDE" };

/** Turns the air's machine-readable reasons into something an operator can act on. */
export function describeReason(reason: string | null): string {
  if (reason === null) return "";
  if (reason.startsWith("missing-boxes:")) {
    const boxes = reason.slice("missing-boxes:".length).split(",").map((id) => BOX_NAMES[id] ?? `box ${id}`);
    return `${boxes.join(", ")} missing in the FC build/config`;
  }
  const known: Record<string, string> = {
    "setting-disabled": "flight control disabled",
    "no-fc-link": "no flight controller connected",
    "link-opened": "waiting to identify the FC",
    "link-closed": "FC link closed",
    "passthrough-busy": "waiting for the Configurator/GCS link to go idle",
    "unsupported-link-type": "not an MSP link (MAVLink/CRSF detected)",
    "unsupported-api-version": "MSP API version not supported",
    "unsupported-firmware": "not Betaflight (e.g. INAV or ArduPilot detected)",
    "unsupported-firmware-version": "Betaflight version not in the allowlist",
    "malformed-boxes": "unexpected mode (box) list from the FC",
    "unsupported-rx-map": "RX channel map puts a stick on an AUX channel",
    "hover-throttle-not-fixed": "ap_hover_throttle is 0 (capture mode); set a fixed value",
    "identification-timeout": "FC did not answer the identification",
    "malformed-identification-reply": "malformed identification reply",
    "fc-link-recovered": "FC link recovered, re-identifying",
    "override-mask-mismatch": "MSP override mask check failed (sticks didn't follow)",
    "fc-link-lost": "FC link lost",
    "fc-link-opened": "FC link opened",
    "not-verified": "FC not verified",
    "channel-closed": "flight-control channel closed",
    "page-hidden": "air app hidden or in the background",
    "air-stalled": "air app stalled (frozen or throttled) and the FC handed the sticks back",
    "telemetry-stale": "FC telemetry stale",
    "sp-took-control": "safety pilot switched the handover off",
    "pos-hold-lost": "POS HOLD switched off",
    disarmed: "disarmed",
    "rx-failsafe": "RC receiver failsafe",
    "gps-lost": "GPS fix lost",
    "heartbeat-lost": "no commands from the ground",
    "heartbeat-restored": "commands resumed",
    "ground-release": "handed back from the ground",
    "handover-ended": "handover switch off",
    "awaiting-fresh-handover": "handover switch was already on: the safety pilot must flip it off and on again",
    handover: "safety pilot handed over",
    unlocked: "unlocked",
    abort: "ABORT",
  };
  if (reason.startsWith("unlock-refused:")) {
    const why = reason.slice("unlock-refused:".length);
    const detail: Record<string, string> = {
      "not-handed-over": "not handed over",
      "sticks-not-neutral": "safety pilot's sticks are not centered (throttle at hover)",
      "no-rc": "no current RC reading from the FC",
    };
    return `unlock refused: ${detail[why] ?? why}`;
  }
  return known[reason] ?? reason;
}

function banner(state: FlightControlState): { text: string; tone: Tone } | null {
  if (!state.flightControlEnabled) return null;
  const { state: supervisorState, reason } = state.supervisor;
  switch (supervisorState) {
    case "IDLE":
      return { text: "Safety pilot in control", tone: "neutral" };
    case "HANDED_OVER":
      return { text: "Handed over – locked", tone: "warn" };
    case "ACTIVE":
      return { text: "Phone pilot in control", tone: "ok" };
    case "NEUTRAL":
      return { text: "Phone pilot in control – no commands, holding position", tone: "warn" };
    case "ABORTED":
      return { text: "Aborted – hovering", tone: "danger" };
    case "RELEASED":
      if (reason === "sp-took-control") return { text: "Safety pilot took back control", tone: "neutral" };
      if (reason === "ground-release") return { text: "Handed back – safety pilot in control", tone: "neutral" };
      return { text: `Released – safety pilot in control (${describeReason(reason)})`, tone: "warn" };
  }
}

function linkMode(state: FlightControlState): { text: string; tone: Tone } {
  const { mode, reason } = state.link;
  if (mode === "verified") return { text: "Flight control ready", tone: "ok" };
  if (mode === "pending") return { text: reason ? `Identifying… (${describeReason(reason)})` : "Identifying…", tone: "neutral" };
  if (!state.flightControlEnabled) return { text: "Transparent – flight control disabled", tone: "neutral" };
  return { text: `Transparent – ${describeReason(reason) || "no reason given"}`, tone: "warn" };
}

function fixed(value: number | null, digits: number, unit: string): string {
  return value === null ? "—" : `${value.toFixed(digits)} ${unit}`;
}

function telemetryRows(state: FlightControlState): FlightControlView["telemetry"] {
  const t = state.telemetry;
  if (!t) return [];
  const modes = t.modes.map((mode) => (mode === "POSHOLD" ? "POS HOLD" : mode === "MSP_OVERRIDE" ? "MSP OVERRIDE" : mode));
  return [
    { label: "Armed", value: t.armed ? "ARMED" : "disarmed", tone: t.armed ? "warn" : "neutral" },
    { label: "Modes", value: modes.length > 0 ? modes.join(" · ") : "—", tone: "neutral" },
    { label: "RX failsafe", value: t.rxFailsafe ? "FAILSAFE" : "ok", tone: t.rxFailsafe ? "danger" : "ok" },
    {
      label: "GPS",
      value: `${t.gps.fix ? "3D fix" : "no fix"}, ${t.gps.numSat} sats`,
      tone: t.gps.fix && t.gps.numSat >= MIN_GPS_SATS ? "ok" : "warn",
    },
    { label: "Altitude", value: fixed(t.altitudeM, 1, "m"), tone: "neutral" },
    { label: "Vario", value: fixed(t.varioMS, 1, "m/s"), tone: "neutral" },
    { label: "Heading", value: t.headingDeg === null ? "—" : `${Math.round(t.headingDeg)}°`, tone: "neutral" },
    {
      label: "Attitude",
      value: t.rollDeg === null || t.pitchDeg === null ? "—" : `roll ${t.rollDeg.toFixed(1)}°, pitch ${t.pitchDeg.toFixed(1)}°`,
      tone: "neutral",
    },
    { label: "Battery", value: fixed(t.voltageV, 2, "V"), tone: "neutral" },
    // Whose sticks the FC flies: the SP's, or the phone's while the override is applied.
    { label: "FC sticks R P Y T", value: t.sticksUs ? t.sticksUs.join(" ") : "—", tone: "neutral" },
  ];
}

function goNoGo(state: FlightControlState | null, ctx: ViewContext, stale: boolean): FlightControlView["goNoGo"] {
  const t = state?.telemetry ?? null;
  const has = (mode: string) => t?.modes.includes(mode as never) ?? false;
  const items: GoNoGoItem[] = [
    { key: "fresh", label: "Air state current", ok: state !== null && !stale, detail: state === null ? "no state yet" : stale ? "STALE" : null },
    { key: "channel", label: "Flight-control channel open", ok: ctx.channelOpen, detail: null },
    { key: "setting", label: "Flight control enabled on the air unit", ok: state?.flightControlEnabled ?? false, detail: null },
    {
      key: "fc",
      label: "FC verified (Betaflight, supported)",
      ok: state?.link.mode === "verified",
      detail: state && state.link.mode !== "verified" ? describeReason(state.link.reason) || null : null,
    },
    { key: "armed", label: "Armed by the safety pilot", ok: t?.armed ?? false, detail: null },
    { key: "poshold", label: "POS HOLD active", ok: has("POSHOLD"), detail: null },
    { key: "handover", label: "Handover switch on (MSP OVERRIDE)", ok: has("MSP_OVERRIDE"), detail: null },
    { key: "rx", label: "RC link ok (no failsafe)", ok: t !== null && !t.rxFailsafe, detail: null },
    {
      key: "gps",
      label: `GPS fix, ≥ ${MIN_GPS_SATS} satellites`,
      ok: t !== null && t.gps.fix && t.gps.numSat >= MIN_GPS_SATS,
      detail: t ? `${t.gps.numSat} sats` : null,
    },
    {
      key: "rtt",
      label: `Round trip ≤ ${RTT_GATE_MS} ms`,
      ok: ctx.rttMs !== null && ctx.rttMs <= RTT_GATE_MS,
      detail: ctx.rttMs === null ? "unknown" : `${Math.round(ctx.rttMs)} ms`,
    },
  ];
  return { go: items.every((item) => item.ok), items };
}

/** Everything the flight-control panel shows, derived from the latest air-reported fc-state. */
export function describeFlightControl(state: FlightControlState | null, ctx: ViewContext): FlightControlView {
  const stateAgeMs = ctx.receivedAt === null ? null : Math.max(0, ctx.now - ctx.receivedAt);
  const stale = stateAgeMs === null || stateAgeMs > STALE_AFTER_MS;
  const supervisorState = state?.supervisor.state ?? null;
  return {
    noState: state === null,
    stale,
    stateAgeMs,
    channelOpen: ctx.channelOpen,
    flightControlEnabled: state?.flightControlEnabled ?? false,
    settingChangeAllowed:
      state !== null && !stale && ctx.channelOpen && (supervisorState === "IDLE" || supervisorState === "RELEASED"),
    linkType: state ? LINK_TYPE_LABELS[state.link.detectedType] : "—",
    linkMode: state ? linkMode(state) : { text: "No flight-control state from the air unit", tone: "neutral" },
    fcIdentity: state?.fc ? `${state.fc.variant} ${state.fc.version} · ${state.fc.board} · MSP API ${state.fc.apiVersion}` : null,
    banner: state ? banner(state) : null,
    supervisor: { state: supervisorState, reason: state ? describeReason(state.supervisor.reason) || null : null },
    goNoGo: goNoGo(state, ctx, stale),
    telemetry: state ? telemetryRows(state) : [],
  };
}
