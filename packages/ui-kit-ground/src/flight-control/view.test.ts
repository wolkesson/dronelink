import { describe, expect, it } from "vitest";
import { describeFlightControl, describeReason, type ViewContext } from "./view.js";
import { fcState } from "./test-state.test-util.js";

const ctx = (overrides: Partial<ViewContext> = {}): ViewContext => ({ now: 1_000, receivedAt: 900, channelOpen: true, rttMs: 80, ...overrides });

describe("describeFlightControl", () => {
  it("describes a missing state", () => {
    const view = describeFlightControl(null, ctx({ receivedAt: null }));
    expect(view).toMatchObject({
      noState: true, stale: true, stateAgeMs: null, flightControlEnabled: false, settingChangeAllowed: false,
      linkType: "—", fcIdentity: null, banner: null, supervisor: { state: null, reason: null }, telemetry: [],
    });
    expect(view.linkMode.text).toMatch(/No flight-control state/);
    expect(view.goNoGo.go).toBe(false);
    expect(view.goNoGo.items.find((item) => item.key === "fresh")?.detail).toBe("no state yet");
  });

  it("says Transparent – flight control disabled, with no banner, when the setting is off", () => {
    const view = describeFlightControl(
      fcState("IDLE", { flightControlEnabled: false, link: { mode: "transparent", reason: "setting-disabled", detectedType: "msp-v1" }, fc: null }),
      ctx(),
    );
    expect(view.linkMode).toEqual({ text: "Transparent – flight control disabled", tone: "neutral" });
    expect(view.banner).toBeNull();
    expect(view.settingChangeAllowed).toBe(true);
    expect(view.goNoGo.items.find((item) => item.key === "setting")?.ok).toBe(false);
  });

  it.each([
    ["unsupported-firmware", "MAVLink v2", "mavlink-v2", /not Betaflight/],
    ["unsupported-link-type", "MAVLink v2", "mavlink-v2", /not an MSP link/],
    ["unsupported-firmware-version", "MSP v1", "msp-v1", /not in the allowlist/],
    ["missing-boxes:50", "MSP v2", "msp-v2", /MSP OVERRIDE missing/],
    [null, "CRSF", "crsf", /no reason given/],
  ] as const)("shows a transparent FC with a readable reason (%s)", (reason, label, detectedType, text) => {
    const view = describeFlightControl(
      fcState("IDLE", { link: { mode: "transparent", reason, detectedType }, fc: null, telemetry: null }),
      ctx(),
    );
    expect(view.linkType).toBe(label);
    expect(view.linkMode.text).toMatch(/^Transparent – /);
    expect(view.linkMode.text).toMatch(text);
    expect(view.linkMode.tone).toBe("warn");
    expect(view.goNoGo.items.find((item) => item.key === "fc")).toMatchObject({ ok: false });
  });

  it("shows identification in progress and a ready FC", () => {
    expect(describeFlightControl(fcState("IDLE", { link: { mode: "pending", reason: null, detectedType: "unknown" } }), ctx()).linkMode.text).toBe("Identifying…");
    expect(
      describeFlightControl(fcState("IDLE", { link: { mode: "pending", reason: "passthrough-busy", detectedType: "silent" } }), ctx()).linkMode.text,
    ).toMatch(/Identifying… \(waiting for the Configurator/);
    const ready = describeFlightControl(fcState(), ctx());
    expect(ready.linkMode).toEqual({ text: "Flight control ready", tone: "ok" });
    expect(ready.fcIdentity).toBe("BTFL 2026.6.2 · SPEEDYBEEF405 · MSP API 1.48");
  });

  it.each([
    ["IDLE", null, "Safety pilot in control"],
    ["HANDED_OVER", "handover", "Handed over – locked"],
    ["ACTIVE", "unlocked", "Phone pilot in control"],
    ["NEUTRAL", "heartbeat-lost", "Phone pilot in control – no commands, holding position"],
    ["ABORTED", "abort", "Aborted – hovering"],
    ["RELEASED", "sp-took-control", "Safety pilot took back control"],
    ["RELEASED", "ground-release", "Handed back – safety pilot in control"],
    ["RELEASED", "pos-hold-lost", "Released – safety pilot in control (POS HOLD switched off)"],
  ] as const)("banners %s (%s)", (state, reason, text) => {
    expect(describeFlightControl(fcState(state, { reason }), ctx()).banner?.text).toBe(text);
  });

  it("allows the setting only outside active control, with a fresh state and an open channel", () => {
    expect(describeFlightControl(fcState("RELEASED"), ctx()).settingChangeAllowed).toBe(true);
    expect(describeFlightControl(fcState("HANDED_OVER"), ctx()).settingChangeAllowed).toBe(false);
    expect(describeFlightControl(fcState("IDLE"), ctx({ channelOpen: false })).settingChangeAllowed).toBe(false);
    expect(describeFlightControl(fcState("IDLE"), ctx({ now: 2_000 })).settingChangeAllowed).toBe(false);
  });

  it("goes STALE after one second", () => {
    expect(describeFlightControl(fcState(), ctx({ now: 1_900 }))).toMatchObject({ stale: false, stateAgeMs: 1_000 });
    const stale = describeFlightControl(fcState(), ctx({ now: 1_901 }));
    expect(stale.stale).toBe(true);
    expect(stale.goNoGo.items[0]).toMatchObject({ ok: false, detail: "STALE" });
    expect(describeFlightControl(fcState(), ctx({ now: 0 })).stateAgeMs).toBe(0);
  });

  it("is go only when every precondition holds", () => {
    expect(describeFlightControl(fcState(), ctx()).goNoGo.go).toBe(true);
    const failing = (state = fcState(), c = ctx()) => describeFlightControl(state, c).goNoGo.items.filter((item) => !item.ok).map((item) => item.key);
    const t = fcState().telemetry!;
    expect(failing(fcState("IDLE", { telemetry: { ...t, armed: false } }))).toEqual(["armed"]);
    expect(failing(fcState("IDLE", { telemetry: { ...t, modes: ["ALTHOLD"] } }))).toEqual(["poshold", "handover"]);
    expect(failing(fcState("IDLE", { telemetry: { ...t, rxFailsafe: true } }))).toEqual(["rx"]);
    expect(failing(fcState("IDLE", { telemetry: { ...t, gps: { ...t.gps, numSat: 7 } } }))).toEqual(["gps"]);
    expect(failing(fcState("IDLE", { telemetry: null }))).toEqual(["armed", "poshold", "handover", "rx", "gps"]);
    expect(failing(fcState(), ctx({ rttMs: 401 }))).toEqual(["rtt"]);
    expect(failing(fcState(), ctx({ rttMs: null }))).toEqual(["rtt"]);
    expect(failing(fcState(), ctx({ channelOpen: false }))).toEqual(["channel"]);
  });

  it("formats telemetry", () => {
    const rows = Object.fromEntries(describeFlightControl(fcState(), ctx()).telemetry.map((row) => [row.label, row]));
    expect(rows.Armed).toMatchObject({ value: "ARMED", tone: "warn" });
    expect(rows.Modes.value).toBe("ALTHOLD · POS HOLD · MSP OVERRIDE");
    expect(rows["RX failsafe"]).toMatchObject({ value: "ok", tone: "ok" });
    expect(rows.GPS).toMatchObject({ value: "3D fix, 12 sats", tone: "ok" });
    expect(rows.Altitude.value).toBe("12.3 m");
    expect(rows.Vario.value).toBe("-0.5 m/s");
    expect(rows.Heading.value).toBe("272°");
    expect(rows.Attitude.value).toBe("roll -1.5°, pitch 2.3°");
    expect(rows.Battery.value).toBe("16.80 V");

    const empty = fcState().telemetry!;
    const sparse = Object.fromEntries(
      describeFlightControl(
        fcState("IDLE", {
          telemetry: {
            ...empty, armed: false, modes: [], rxFailsafe: true, gps: { fix: false, numSat: 0, latitude: null, longitude: null },
            altitudeM: null, varioMS: null, headingDeg: null, rollDeg: null, pitchDeg: null, voltageV: null,
          },
        }),
        ctx(),
      ).telemetry.map((row) => [row.label, row]),
    );
    expect(sparse.Armed).toMatchObject({ value: "disarmed", tone: "neutral" });
    expect(sparse.Modes.value).toBe("—");
    expect(sparse["RX failsafe"]).toMatchObject({ value: "FAILSAFE", tone: "danger" });
    expect(sparse.GPS).toMatchObject({ value: "no fix, 0 sats", tone: "warn" });
    expect([sparse.Altitude, sparse.Heading, sparse.Attitude, sparse.Battery].map((row) => row.value)).toEqual(["—", "—", "—", "—"]);
    expect(
      describeFlightControl(fcState("IDLE", { telemetry: { ...empty, rollDeg: 1, pitchDeg: null } }), ctx()).telemetry.find((row) => row.label === "Attitude")?.value,
    ).toBe("—");
  });
});

describe("describeReason", () => {
  it("translates the air's reason codes", () => {
    expect(describeReason(null)).toBe("");
    expect(describeReason("missing-boxes:0,3,11,99")).toBe("ARM, ALTHOLD, POS HOLD, box 99 missing in the FC build/config");
    expect(describeReason("unlock-refused:sticks-not-neutral")).toMatch(/sticks are not centered/);
    expect(describeReason("unlock-refused:something-new")).toBe("unlock refused: something-new");
    expect(describeReason("hover-throttle-not-fixed")).toMatch(/ap_hover_throttle/);
    expect(describeReason("brand-new-reason")).toBe("brand-new-reason");
  });
});
