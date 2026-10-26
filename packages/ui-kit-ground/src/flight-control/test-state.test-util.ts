import type { FlightControlState, SupervisorState } from "@dronelink/core-transport";

/** A schema-valid fc-state: a verified Betaflight, armed in POS HOLD with the handover switch on. */
export function fcState(
  supervisor: SupervisorState = "HANDED_OVER",
  overrides: Partial<Omit<FlightControlState, "supervisor">> & { reason?: string | null; lastAppliedSeq?: number | null } = {},
): FlightControlState {
  const { reason = null, lastAppliedSeq = null, ...rest } = overrides;
  return {
    type: "fc-state",
    sentAt: 1,
    flightControlEnabled: true,
    link: { mode: "verified", reason: null, detectedType: "msp-v1" },
    fc: { variant: "BTFL", version: "2026.6.2", apiVersion: "1.48", board: "SPEEDYBEEF405" },
    supervisor: { state: supervisor, reason, lastAppliedSeq },
    telemetry: {
      armed: true,
      modes: ["ALTHOLD", "POSHOLD", "MSP_OVERRIDE"],
      rxFailsafe: false,
      gps: { fix: true, numSat: 12, latitude: 59.3, longitude: 18.07 },
      altitudeM: 12.34,
      varioMS: -0.5,
      headingDeg: 271.6,
      rollDeg: -1.5,
      pitchDeg: 2.25,
      voltageV: 16.8,
      sticksUs: [1500, 1500, 1500, 1300],
    },
    limits: {
      commandRateHz: 20,
      neutralTimeoutMs: 250,
      releaseTimeoutMs: 1000,
      hoverThrottleUs: 1300,
      maxDeflectionUs: { roll: 150, pitch: 150, yaw: 150, throttle: 150 },
    },
    rejectedMessages: 0,
    ...rest,
  };
}
