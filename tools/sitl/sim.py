#!/usr/bin/env python3
"""Manual Betaflight SITL flight simulator for DroneLink testing.

Runs a Betaflight SITL build with Betaflight's own harness feeding it a simple quad motion
model, virtual GPS and RC, and lets you play the safety pilot from the keyboard: arm, take
off, switch ALT+POS HOLD, flip the MSP OVERRIDE handover switch and move the sticks. UART1
(TCP 5761) is left free for the DroneLink chain (tools/sitl-serial-bridge.mjs -> air-webapp
-> ground-core-node -> Configurator); the simulator watches the FC over UART2 (TCP 5762).

  python3 tools/sitl/sim.py --bf-dir <betaflight checkout>            # keyboard UI
  python3 tools/sitl/sim.py --bf-dir <...> --headless --takeoff       # fly to a hover, log status

Keys (UI):  t take off into POS HOLD   a arm/disarm   h ALT+POS HOLD   n ANGLE
            o handover (MSP OVERRIDE)  x RC link on/off (TX off -> failsafe)
            arrows pitch/roll  q/e yaw  r/f throttle  space center sticks  Q quit

The configuration (written to <workdir>/eeprom.bin on first start, or with --fresh) is the
one from ARCHITECTURE.md section 7 / docs/sim/betaflight-sitl.md: MSP override on the four
stick channels, msp_override_failsafe OFF, hover throttle 1275, ALTHOLD+POSHOLD on one switch.
"""

import argparse
import math
import os
import struct
import sys
import threading
import time

import msp_override_spike as spike

MONITOR_PORT = 5762  # UART2; UART1 (5761) stays free for DroneLink
MSP_RC = 105
MSP_RAW_GPS = 106

STICK_STEP = 50
THROTTLE_STEP = 25
STICK_LIMIT = 500

# Betaflight 2026.6 fc/runtime_config.c armingDisableFlagNames
ARMING_DISABLE_FLAGS = [
    "NOGYRO", "FAILSAFE", "RXLOSS", "NOT_DISARMED", "BOXFAILSAFE", "RUNAWAY", "CRASH", "THROTTLE",
    "ANGLE", "BOOTGRACE", "NOPREARM", "LOAD", "CALIB", "CLI", "CMS", "BST", "MSP", "PARALYZE",
    "GPS", "RESCUE_SW", "DSHOT_TELEM", "REBOOT_REQD", "DSHOT_BBANG", "NO_ACC_CAL", "MOTOR_PROTO",
    "FLIP_SWITCH", "ALT_HOLD_SW", "POS_HOLD_SW", "AUTOPILOT_SW", "ARM_SWITCH",
]

MODE_NAMES = {0: "ARM", 1: "ANGLE", 3: "ALTHOLD", 11: "POSHOLD", 27: "FAILSAFE", 46: "GPSRESCUE", 50: "MSP OVERRIDE"}

h = None  # Betaflight harness module, imported in main()


def sim_config():
    return spike.spike_config(False) + [
        "serial 1 1 115200 57600 0 115200",  # MSP on UART2 for the simulator's own monitor
    ]


class Monitor(threading.Thread):
    """Polls the FC over UART2 at 5 Hz. Read-only; errors keep the last snapshot."""

    def __init__(self, sitl):
        super().__init__(daemon=True)
        self.sitl = sitl
        self.running = True
        self.lock = threading.Lock()
        self.snapshot = {"modes": set(), "arming_flags": None, "rc": [], "sats": None, "fix": None, "age": None}
        self.updated_at = None

    def run(self):
        while self.running:
            try:
                status = self.sitl.status()
                p = self.sitl.msp.request(MSP_RC)
                rc = list(struct.unpack(f"<{len(p) // 2}H", p))
                g = self.sitl.msp.request(MSP_RAW_GPS)
                with self.lock:
                    self.snapshot = {"modes": status["modes"], "arming_flags": status["arming_flags"], "rc": rc,
                                     "fix": g[0] != 0, "sats": g[1]}
                    self.updated_at = time.monotonic()
            except (TimeoutError, RuntimeError, OSError, struct.error):
                pass
            time.sleep(0.2)

    def get(self):
        with self.lock:
            snap = dict(self.snapshot)
            snap["age"] = None if self.updated_at is None else time.monotonic() - self.updated_at
            return snap

    def shutdown(self):
        self.running = False


class Pilot:
    """The safety pilot's transmitter: stick and switch state pushed into the RC feed."""

    def __init__(self, rc):
        self.rc = rc
        self.roll = self.pitch = self.yaw = 1500
        self.throttle = 1000
        self.switches = {spike.CH_ARM: False, spike.CH_HOLD: False, spike.CH_ANGLE: True, spike.CH_OVERRIDE: False}
        self.link_on = True
        self.busy = None  # description of a running macro
        self.message = ""
        self.apply()

    def apply(self):
        self.rc.set(spike.CH_ROLL, self.roll)
        self.rc.set(spike.CH_PITCH, self.pitch)
        self.rc.set(spike.CH_YAW, self.yaw)
        self.rc.set(spike.CH_THROTTLE, self.throttle)
        for ch, on in self.switches.items():
            self.rc.set(ch, h.RC_HIGH if on else 1000)

    def nudge(self, attr, delta, low=1500 - STICK_LIMIT, high=1500 + STICK_LIMIT):
        setattr(self, attr, max(low, min(high, getattr(self, attr) + delta)))
        self.apply()

    def center(self):
        self.roll = self.pitch = self.yaw = 1500
        if self.switches[spike.CH_ARM]:
            self.throttle = spike.HOVER_THROTTLE
        self.apply()

    def toggle(self, ch):
        self.switches[ch] = not self.switches[ch]
        self.apply()

    def toggle_link(self):
        self.link_on = not self.link_on
        self.rc.streaming = self.link_on


def wait_until(predicate, timeout):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if predicate():
            return True
        time.sleep(0.2)
    return False


def take_off(sitl, pilot, monitor):
    """Arm in ANGLE, climb clear of the ground, park the throttle at hover, engage the holds."""
    pilot.busy = "take-off: waiting for GPS fix and arming flags"
    try:
        if not wait_until(lambda: monitor.get()["arming_flags"] == 0, 40):
            pilot.message = "take-off aborted: arming still blocked (see arming flags)"
            return
        pilot.busy = "take-off: accelerometer calibration"
        pilot.roll = pilot.pitch = pilot.yaw = 1500
        pilot.throttle = 1000
        pilot.switches.update({spike.CH_ANGLE: True, spike.CH_HOLD: False, spike.CH_OVERRIDE: False, spike.CH_ARM: False})
        pilot.apply()
        # Recalibrate once the FDM feed is live (as Betaflight's harness does), then wait for
        # the arming flags to clear again: arming while one is set latches ARM_SWITCH.
        sitl.acc_calibrate()
        time.sleep(2.0)
        if not wait_until(lambda: monitor.get()["arming_flags"] == 0, 20):
            pilot.message = "take-off aborted: arming blocked after calibration (see arming flags)"
            return
        pilot.busy = "take-off: arming"
        for attempt in range(3):
            pilot.switches[spike.CH_ARM] = True
            pilot.apply()
            if wait_until(lambda: h.BOX_ARM in monitor.get()["modes"], 8):
                break
            pilot.switches[spike.CH_ARM] = False
            pilot.apply()
            if attempt == 2:
                pilot.message = "take-off aborted: did not arm"
                return
            time.sleep(1.0)
        pilot.busy = "take-off: climbing"
        pilot.throttle = 1600
        pilot.apply()
        time.sleep(3.0)
        pilot.throttle = spike.HOVER_THROTTLE
        pilot.switches[spike.CH_HOLD] = True
        pilot.apply()
        pilot.message = "hovering in ALT+POS HOLD; press o to hand over"
    finally:
        pilot.busy = None


def status_lines(fdm, pilot, monitor):
    m = fdm.model
    snap = monitor.get()
    flags = snap["arming_flags"]
    if flags is None:
        arming = "?"
    elif flags == 0:
        arming = "ready"
    else:
        arming = " ".join(n for i, n in enumerate(ARMING_DISABLE_FLAGS) if flags & (1 << i)) or hex(flags)
    modes = " ".join(MODE_NAMES.get(b, f"BOX{b}") for b in sorted(snap["modes"])) or "-"
    rc = snap["rc"]
    fc_sticks = f"R{rc[0]} P{rc[1]} Y{rc[2]} T{rc[3]}" if len(rc) >= 4 else "-"
    tx_sticks = f"R{pilot.roll} P{pilot.pitch} Y{pilot.yaw} T{pilot.throttle}"
    sw = pilot.switches
    switches = (f"ARM {'ON ' if sw[spike.CH_ARM] else 'off'}  HOLD {'ON ' if sw[spike.CH_HOLD] else 'off'}  "
                f"ANGLE {'ON ' if sw[spike.CH_ANGLE] else 'off'}  HANDOVER {'ON ' if sw[spike.CH_OVERRIDE] else 'off'}  "
                f"RC LINK {'on' if pilot.link_on else 'OFF'}")
    age = snap["age"]
    return [
        "DroneLink SITL simulator - UART1 tcp 5761 free for DroneLink, monitor on UART2 tcp 5762",
        "",
        f"FC modes     : {modes}",
        f"Arming       : {arming}",
        f"GPS          : {'fix' if snap['fix'] else 'no fix'}  sats {snap['sats'] if snap['sats'] is not None else '-'}",
        f"Monitor      : {'stale' if age is None or age > 1.0 else 'live'}",
        "",
        f"Safety pilot : {tx_sticks}",
        f"FC rcData    : {fc_sticks}   (differs from the TX while the phone overrides)",
        f"Switches     : {switches}",
        "",
        f"Truth        : alt {m.pos[2]:6.1f} m  home dist {math.hypot(m.pos[0], m.pos[1]):6.1f} m  "
        f"speed {math.hypot(m.vel[0], m.vel[1]):4.1f} m/s  vz {m.vel[2]:+4.1f} m/s  hdg {math.degrees(m.yaw) % 360:5.1f}",
        "",
        pilot.busy or pilot.message,
    ]


KEY_HELP = [
    "t take off   a arm   h ALT+POS HOLD   n ANGLE   o handover   x RC link   Q quit",
    "arrows pitch/roll   q/e yaw   r/f throttle   space center (throttle -> hover)",
]


def run_ui(sitl, fdm, pilot, monitor):
    import curses

    def loop(screen):
        curses.curs_set(0)
        screen.nodelay(True)
        screen.timeout(100)
        while True:
            key = screen.getch()
            if key == ord("Q"):
                return
            handle_key(key, sitl, pilot, monitor, curses)
            screen.erase()
            for row, line in enumerate(status_lines(fdm, pilot, monitor) + [""] + KEY_HELP):
                try:
                    screen.addstr(row, 0, line[: max(0, curses.COLS - 1)])
                except curses.error:
                    pass
            screen.refresh()

    curses.wrapper(loop)


def handle_key(key, sitl, pilot, monitor, curses):
    if key == -1:
        return
    if key == ord("t"):
        if pilot.busy is None:
            threading.Thread(target=take_off, args=(sitl, pilot, monitor), daemon=True).start()
        return
    actions = {
        ord("a"): lambda: pilot.toggle(spike.CH_ARM),
        ord("h"): lambda: pilot.toggle(spike.CH_HOLD),
        ord("n"): lambda: pilot.toggle(spike.CH_ANGLE),
        ord("o"): lambda: pilot.toggle(spike.CH_OVERRIDE),
        ord("x"): pilot.toggle_link,
        ord(" "): pilot.center,
        curses.KEY_UP: lambda: pilot.nudge("pitch", STICK_STEP),
        curses.KEY_DOWN: lambda: pilot.nudge("pitch", -STICK_STEP),
        curses.KEY_RIGHT: lambda: pilot.nudge("roll", STICK_STEP),
        curses.KEY_LEFT: lambda: pilot.nudge("roll", -STICK_STEP),
        ord("e"): lambda: pilot.nudge("yaw", STICK_STEP),
        ord("q"): lambda: pilot.nudge("yaw", -STICK_STEP),
        ord("r"): lambda: pilot.nudge("throttle", THROTTLE_STEP, 1000, 2000),
        ord("f"): lambda: pilot.nudge("throttle", -THROTTLE_STEP, 1000, 2000),
    }
    action = actions.get(key)
    if action:
        pilot.message = ""
        action()


def run_headless(sitl, fdm, pilot, monitor, takeoff, handover, duration):
    if takeoff:
        take_off(sitl, pilot, monitor)
        if pilot.message:
            print(f"[sim] {pilot.message}", flush=True)
    if handover:
        pilot.toggle(spike.CH_OVERRIDE)
    deadline = None if duration is None else time.monotonic() + duration
    while deadline is None or time.monotonic() < deadline:
        lines = status_lines(fdm, pilot, monitor)
        print("[sim] " + " | ".join(line for line in lines[2:12] if line), flush=True)
        time.sleep(1.0)


def main():
    global h
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--bf-dir", required=True, help="Betaflight checkout with a built SITL target")
    ap.add_argument("--binary", help="SITL binary (default: <bf-dir>/obj/main/betaflight_SITL.elf)")
    ap.add_argument("--workdir", default="sitl-sim", help="where SITL keeps eeprom.bin and logs (default ./sitl-sim)")
    ap.add_argument("--fresh", action="store_true", help="rewrite eeprom.bin with the simulator config")
    ap.add_argument("--headless", action="store_true", help="no keyboard UI; print status once a second")
    ap.add_argument("--takeoff", action="store_true", help="headless: take off into POS HOLD at start")
    ap.add_argument("--handover", action="store_true", help="headless: flip the handover switch after take-off")
    ap.add_argument("--duration", type=float, help="headless: exit after this many seconds")
    args = ap.parse_args()

    sys.path.insert(0, os.path.join(os.path.abspath(args.bf_dir), "src", "test", "sitl"))
    import sitl_harness
    h = spike.h = sitl_harness
    h.TELEMETRY_PORT = 0
    h.TCP_PORT = MONITOR_PORT

    binary = args.binary or os.path.join(args.bf_dir, "obj", "main", "betaflight_SITL.elf")
    workdir = os.path.abspath(args.workdir)
    os.makedirs(workdir, exist_ok=True)
    sitl = h.Sitl(binary, workdir)
    if args.fresh or not os.path.exists(os.path.join(workdir, "eeprom.bin")):
        print(f"[sim] writing simulator config to {workdir}/eeprom.bin", flush=True)
        sitl.provision(sim_config())

    rc = h.RcFeed()
    motors = h.MotorFeed()
    fdm = h.FdmFeed(motors)
    monitor = None
    try:
        try:
            sitl.start()
        except RuntimeError as err:
            sys.exit(f"[sim] could not start SITL: {err}. Is another SITL still running? "
                     f"An eeprom.bin from elsewhere may also lack MSP on UART2: retry with --fresh.")
        motors.start()
        rc.start()
        fdm.start()
        monitor = Monitor(sitl)
        monitor.start()
        pilot = Pilot(rc)
        print(f"[sim] SITL running (log: {workdir}/sitl.log); DroneLink: node tools/sitl-serial-bridge.mjs", flush=True)
        if args.headless:
            run_headless(sitl, fdm, pilot, monitor, args.takeoff, args.handover, args.duration)
        else:
            run_ui(sitl, fdm, pilot, monitor)
    except KeyboardInterrupt:
        pass
    finally:
        for feed in (monitor, rc, fdm, motors):
            if feed is not None:
                feed.shutdown()
        sitl.stop()


if __name__ == "__main__":
    main()
