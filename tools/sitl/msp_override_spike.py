#!/usr/bin/env python3
"""Betaflight SITL spike for flight control over MSP Override (issue #81).

Answers the questions the flight-control safety model (ARCHITECTURE.md
section 7) depends on, against a real Betaflight SITL build:

  - when the MSP_SET_RAW_RC stream stops, do the overridden channels fall back
    to the RC receiver, and after how long?
  - does turning the MSP OVERRIDE switch off hand control back immediately?
  - can the link touch channels outside msp_override_channels_mask (AUX/ARM)?
  - is RC loss still detected while MSP frames keep arriving?
  - what do roll/pitch/yaw/throttle do in ALT HOLD + POS HOLD?

It reuses Betaflight's own SITL harness (src/test/sitl/sitl_harness.py:
motion model, virtual GPS, RC and FDM feeds, MSP client) and adds the phone's
role: a 20 Hz MSP_SET_RAW_RC sender that can be killed abruptly.

Usage:
  python3 tools/sitl/msp_override_spike.py --bf-dir <betaflight checkout> \
      [--binary <bf>/obj/main/betaflight_SITL.elf] [--workdir /tmp/msp_override_spike]
"""

import argparse
import json
import math
import os
import shutil
import struct
import sys
import threading
import time

MSP_RC = 105
MSP_ALTITUDE = 109
MSP_SET_RAW_RC = 200

BOX_ANGLE = 1
BOX_MSPOVERRIDE = 50

# Raw receiver channel indices (harness RcFeed order is AETR + AUX)
CH_ROLL, CH_PITCH, CH_THROTTLE, CH_YAW = 0, 1, 2, 3
CH_ARM, CH_HOLD, CH_ANGLE, CH_OVERRIDE = 4, 5, 6, 7

# rcData indices as reported by MSP_RC (Betaflight internal order RPYT + AUX)
RC_ROLL, RC_PITCH, RC_YAW, RC_THROTTLE = 0, 1, 2, 3
RC_AUX1 = 4

HOVER_THROTTLE = 1275

h = None  # Betaflight harness module, imported in main()


def log(msg):
    print(f"[spike] {msg}", flush=True)


def spike_config(failsafe_override):
    return [
        "feature GPS",
        "set gps_provider = VIRTUAL",
        "set failsafe_procedure = AUTO-LAND",
        "set failsafe_delay = 10",
        "set small_angle = 180",
        "set trust_mag = ON",
        f"set ap_hover_throttle = {HOVER_THROTTLE}",
        "aux 0 0 0 1700 2100 0 0",    # ARM on AUX1
        "aux 1 3 1 1700 2100 0 0",    # ALTHOLD on AUX2
        "aux 2 11 1 1700 2100 0 0",   # POSHOLD on AUX2 (same switch)
        "aux 3 1 2 1700 2100 0 0",    # ANGLE on AUX3
        "aux 4 50 3 1700 2100 0 0",   # MSP OVERRIDE on AUX4 = SP handover switch
        "set msp_override_channels_mask = 15",  # raw AETR, no AUX
        f"set msp_override_failsafe = {'ON' if failsafe_override else 'OFF'}",
    ]


class OverrideSender(threading.Thread):
    """Plays the phone: streams MSP_SET_RAW_RC at 20 Hz until killed."""

    def __init__(self, msp, rate_hz=20.0):
        super().__init__(daemon=True)
        self.msp = msp
        self.period = 1.0 / rate_hz
        self.frame = [1500, 1500, HOVER_THROTTLE, 1500]  # raw AETR
        self.running = True
        self.sent = 0
        self.last_sent_at = None

    def set(self, roll=None, pitch=None, throttle=None, yaw=None, frame=None):
        if frame is not None:
            self.frame = list(frame)
            return
        for idx, val in ((CH_ROLL, roll), (CH_PITCH, pitch), (CH_THROTTLE, throttle), (CH_YAW, yaw)):
            if val is not None:
                self.frame[idx] = val

    def run(self):
        while self.running:
            payload = struct.pack(f"<{len(self.frame)}H", *self.frame)
            try:
                self.msp.request(MSP_SET_RAW_RC, payload, timeout=0.5)
                self.last_sent_at = time.monotonic()
                self.sent += 1
            except (TimeoutError, RuntimeError, OSError):
                pass
            time.sleep(self.period)

    def kill(self):
        self.running = False
        self.join(timeout=1.0)
        return self.last_sent_at


def rc_data(sitl):
    p = sitl.msp.request(MSP_RC)
    return list(struct.unpack(f"<{len(p) // 2}H", p))


def poll_until(sitl, predicate, timeout):
    """Poll MSP_RC as fast as the link allows; return (elapsed_s, samples)."""
    t0 = time.monotonic()
    samples = 0
    while time.monotonic() - t0 < timeout:
        rc = rc_data(sitl)
        samples += 1
        if predicate(rc):
            return time.monotonic() - t0, samples
    return None, samples


def pos(fdm):
    m = fdm.model
    return (m.pos[0], m.pos[1], m.pos[2])


def horiz(a, b):
    return math.hypot(a[0] - b[0], a[1] - b[1])


def speed(fdm):
    return math.hypot(fdm.model.vel[0], fdm.model.vel[1])


def hold_window(fdm, seconds):
    """Fly for `seconds` and report position/altitude/heading drift."""
    p0, hd0 = pos(fdm), fdm.heading_deg()
    time.sleep(seconds)
    p1, hd1 = pos(fdm), fdm.heading_deg()
    dh = (hd1 - hd0 + 180.0) % 360.0 - 180.0
    return {"horiz_m": round(horiz(p0, p1), 2), "alt_m": round(p1[2] - p0[2], 2), "heading_deg": round(dh, 1)}


def take_off_into_pos_hold(sitl, rc, fdm):
    rc.start()
    fdm.start()
    h.wait_for("GPS fix + arming flags clear", lambda: sitl.status()["arming_flags"] == 0, timeout=40)
    sitl.acc_calibrate()
    time.sleep(2.0)
    h.wait_for("recalibration complete", lambda: sitl.status()["arming_flags"] == 0, timeout=20)

    rc.set(CH_ANGLE, h.RC_HIGH)
    for attempt in range(3):
        rc.set(CH_ARM, h.RC_HIGH)
        try:
            h.wait_for("armed", lambda: h.BOX_ARM in sitl.modes(), timeout=8)
            break
        except AssertionError:
            if attempt == 2:
                raise
            rc.set(CH_ARM, 1000)
            time.sleep(1.0)

    rc.set(CH_THROTTLE, 1600)
    time.sleep(3.0)
    rc.set(CH_THROTTLE, HOVER_THROTTLE)  # SP parks the throttle at the hover point
    rc.set(CH_HOLD, h.RC_HIGH)
    h.wait_for("ALTHOLD + POSHOLD active", lambda: {h.BOX_ALTHOLD, h.BOX_POSHOLD} <= sitl.modes())
    time.sleep(5.0)
    log(f"hovering at {pos(fdm)[2]:.1f} m")


def run_flight(sitl, rc, fdm, results):
    take_off_into_pos_hold(sitl, rc, fdm)

    # Phase A: SP sticks centered, no override yet
    results["A_sp_hover_5s"] = hold_window(fdm, 5.0)

    # Phase B: handover switch on, but the phone sends nothing yet
    rc.set(CH_OVERRIDE, h.RC_HIGH)
    h.wait_for("MSP OVERRIDE box active", lambda: BOX_MSPOVERRIDE in sitl.modes())
    rc_now = rc_data(sitl)
    results["B_handover_without_frames"] = {
        "rcData_rpyt": rc_now[:4],
        "follows_sp_sticks": rc_now[:4] == [1500, 1500, 1500, HOVER_THROTTLE],
        "drift_3s": hold_window(fdm, 3.0),
    }

    # Phase C: phone streams neutral sticks (throttle = hover throttle)
    sender = OverrideSender(sitl.msp)
    sender.start()
    time.sleep(0.5)
    results["C_neutral_override_5s"] = hold_window(fdm, 5.0)

    # Phase D: naive "center" throttle of 1500 instead of the hover throttle
    sender.set(throttle=1500)
    alt0 = pos(fdm)[2]
    time.sleep(5.0)
    results["D_throttle_1500_for_5s"] = {"climb_m": round(pos(fdm)[2] - alt0, 2),
                                         "climb_rate_mps": round((pos(fdm)[2] - alt0) / 5.0, 2)}
    sender.set(throttle=HOVER_THROTTLE)
    time.sleep(3.0)

    # Phase E: forward (pitch) and yaw commands
    p0 = pos(fdm)
    sender.set(pitch=1650)
    time.sleep(3.0)
    results["E_pitch_1650_3s"] = {"moved_m": round(horiz(p0, pos(fdm)), 1), "speed_mps": round(speed(fdm), 2),
                                  "rcData_pitch": rc_data(sitl)[RC_PITCH]}
    sender.set(pitch=1500)
    time.sleep(4.0)
    results["E_after_release_4s"] = {"speed_mps": round(speed(fdm), 2), "hold_3s": hold_window(fdm, 3.0)}

    hd0, p0 = fdm.heading_deg(), pos(fdm)
    sender.set(yaw=1650)
    time.sleep(3.0)
    sender.set(yaw=1500)
    dh = (fdm.heading_deg() - hd0 + 180.0) % 360.0 - 180.0
    results["F_yaw_1650_3s"] = {"heading_change_deg": round(dh, 1), "horiz_drift_m": round(horiz(p0, pos(fdm)), 2)}
    time.sleep(3.0)

    # Phase G: the phone dies mid-command (forward + yaw + climb), repeated
    sender.kill()
    reverts = []
    for _ in range(5):
        sender = OverrideSender(sitl.msp)
        sender.set(pitch=1650, yaw=1650, throttle=1600)
        sender.start()
        time.sleep(2.0)
        last = sender.kill()
        t_kill = time.monotonic()
        elapsed, _ = poll_until(
            sitl, lambda r: r[RC_PITCH] == 1500 and r[RC_YAW] == 1500 and r[RC_THROTTLE] == HOVER_THROTTLE,
            timeout=5.0)
        reverts.append(None if elapsed is None else round((t_kill + elapsed - last) * 1000))
        time.sleep(1.0)
    results["G_sender_killed_revert_after_last_frame_ms"] = reverts

    p_kill = pos(fdm)
    track = []
    for _ in range(15):
        time.sleep(1.0)
        p = pos(fdm)
        track.append([round(horiz(p_kill, p), 2), round(p[2] - p_kill[2], 2), round(speed(fdm), 2)])
    results["G_after_last_kill_1hz_[dist_m,dalt_m,speed_mps]"] = track
    results["G_modes_ok"] = {h.BOX_ALTHOLD, h.BOX_POSHOLD, BOX_MSPOVERRIDE} <= sitl.modes()

    # Phase H: SP flips the handover switch back while the phone is still commanding
    sender = OverrideSender(sitl.msp)
    sender.set(pitch=1650)
    sender.start()
    h.wait_for("override applied again", lambda: rc_data(sitl)[RC_PITCH] == 1650, timeout=3)
    rc.set(CH_OVERRIDE, 1000)
    elapsed, _ = poll_until(sitl, lambda r: r[RC_PITCH] == 1500, timeout=3.0)
    results["H_sp_takeback"] = {"revert_ms": None if elapsed is None else round(elapsed * 1000),
                                "sender_still_running": sender.is_alive()}
    sender.set(pitch=1500)
    time.sleep(3.0)

    # Phase I: frames that try to drive AUX channels (ARM low, holds low)
    rc.set(CH_OVERRIDE, h.RC_HIGH)
    time.sleep(0.5)
    sender.set(frame=[1500, 1500, HOVER_THROTTLE, 1500, 1000, 1000, 1000, 1000])
    time.sleep(2.0)
    rc_now = rc_data(sitl)
    modes = sitl.modes()
    results["I_aux_in_frame"] = {"still_armed": h.BOX_ARM in modes,
                                 "holds_still_active": {h.BOX_ALTHOLD, h.BOX_POSHOLD} <= modes,
                                 "rcData_aux1_4": rc_now[RC_AUX1:RC_AUX1 + 4]}
    sender.set(frame=[1500, 1500, HOVER_THROTTLE, 1500])
    time.sleep(2.0)

    # Phase J: SP leaves ALT/POS HOLD while the phone holds a climb on throttle
    sender.set(throttle=1600)
    time.sleep(1.0)
    alt0 = pos(fdm)[2]
    rc.set(CH_HOLD, 1000)
    h.wait_for("holds off", lambda: h.BOX_POSHOLD not in sitl.modes(), timeout=3)
    time.sleep(1.0)
    results["J_holds_off_with_throttle_1600_1s"] = {"climb_m": round(pos(fdm)[2] - alt0, 2)}
    sender.set(throttle=HOVER_THROTTLE)
    rc.set(CH_HOLD, h.RC_HIGH)
    h.wait_for("holds back on", lambda: {h.BOX_ALTHOLD, h.BOX_POSHOLD} <= sitl.modes(), timeout=5)
    time.sleep(3.0)

    # Phase K: RC link lost while the phone keeps streaming
    rc.stop_stream()
    try:
        h.wait_for("failsafe despite MSP frames", lambda: h.BOX_FAILSAFE in sitl.modes(), timeout=5)
        results["K_rc_loss_with_frames"] = {"failsafe": True}
    except AssertionError:
        results["K_rc_loss_with_frames"] = {"failsafe": False}
    sender.kill()


def fc_altitude_m(sitl):
    p = sitl.msp.request(MSP_ALTITUDE)
    est_cm, vario_cms = struct.unpack_from("<ih", p, 0)
    return est_cm / 100.0, vario_cms / 100.0


def run_kill_diagnostics(sitl, rc, fdm, results):
    """Kill the sender after one axis at a time; track truth vs. FC altitude."""
    take_off_into_pos_hold(sitl, rc, fdm)
    rc.set(CH_OVERRIDE, h.RC_HIGH)
    h.wait_for("MSP OVERRIDE box active", lambda: BOX_MSPOVERRIDE in sitl.modes())
    cases = {
        "pitch_1650": dict(pitch=1650),
        "yaw_1650": dict(yaw=1650),
        "throttle_1600": dict(throttle=1600),
        "pitch_yaw_throttle": dict(pitch=1650, yaw=1650, throttle=1600),
    }
    for name, axes in cases.items():
        sender = OverrideSender(sitl.msp)
        sender.set(**axes)
        sender.start()
        time.sleep(3.0)
        sender.kill()
        p_kill = pos(fdm)
        fc0, _ = fc_altitude_m(sitl)
        track = []
        for _ in range(20):
            time.sleep(1.0)
            p = pos(fdm)
            fc_alt, fc_vario = fc_altitude_m(sitl)
            track.append([round(horiz(p_kill, p), 2), round(p[2] - p_kill[2], 2), round(fc_alt - fc0, 2),
                          round(fc_vario, 2), round(speed(fdm), 2)])
        results[f"diag_{name}_1hz_[dist,dalt_truth,dalt_fc,vario_fc,speed]"] = track


def run_rc_loss_with_failsafe_override(sitl, rc, fdm, results):
    """msp_override_failsafe = ON: does an MSP stream mask RC loss?"""
    take_off_into_pos_hold(sitl, rc, fdm)
    rc.set(CH_OVERRIDE, h.RC_HIGH)
    h.wait_for("MSP OVERRIDE box active", lambda: BOX_MSPOVERRIDE in sitl.modes())
    sender = OverrideSender(sitl.msp)
    sender.start()
    time.sleep(1.0)
    rc.stop_stream()
    try:
        h.wait_for("failsafe", lambda: h.BOX_FAILSAFE in sitl.modes(), timeout=5)
        results["L_failsafe_override_on_rc_loss"] = {"failsafe": True}
    except AssertionError:
        results["L_failsafe_override_on_rc_loss"] = {"failsafe": False}
    sender.kill()


def leg(binary, workdir, name, failsafe_override, body, results):
    leg_dir = os.path.join(workdir, name)
    shutil.rmtree(leg_dir, ignore_errors=True)
    os.makedirs(leg_dir)
    sitl = h.Sitl(binary, leg_dir)
    rc = h.RcFeed()
    motors = h.MotorFeed()
    fdm = h.FdmFeed(motors)
    try:
        sitl.provision(spike_config(failsafe_override))
        sitl.start()
        motors.start()
        log(f"=== {name}: boxids {sitl.boxids}")
        results[f"{name}_boxids_has_msp_override"] = BOX_MSPOVERRIDE in sitl.boxids
        body(sitl, rc, fdm, results)
    finally:
        for feed in (rc, fdm, motors):
            feed.shutdown()
        sitl.stop()


def main():
    global h
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--bf-dir", required=True, help="Betaflight checkout with a built SITL target")
    ap.add_argument("--binary", help="SITL binary (default: <bf-dir>/obj/main/betaflight_SITL.elf)")
    ap.add_argument("--workdir", default="/tmp/msp_override_spike")
    ap.add_argument("--json", help="write results to this file")
    ap.add_argument("--diag", action="store_true", help="only run the per-axis link-loss diagnostics")
    args = ap.parse_args()

    sys.path.insert(0, os.path.join(os.path.abspath(args.bf_dir), "src", "test", "sitl"))
    import sitl_harness
    h = sitl_harness
    h.TELEMETRY_PORT = 0

    binary = args.binary or os.path.join(args.bf_dir, "obj", "main", "betaflight_SITL.elf")
    os.makedirs(args.workdir, exist_ok=True)
    results = {}
    if args.diag:
        leg(binary, args.workdir, "diag", False, run_kill_diagnostics, results)
    else:
        leg(binary, args.workdir, "flight", False, run_flight, results)
        leg(binary, args.workdir, "failsafe_override_on", True, run_rc_loss_with_failsafe_override, results)

    print(json.dumps(results, indent=2))
    if args.json:
        with open(args.json, "w") as f:
            json.dump(results, f, indent=2)


if __name__ == "__main__":
    main()
