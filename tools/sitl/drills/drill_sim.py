#!/usr/bin/env python3
"""SITL side of the flight-control failure drills (#89), driven by run-drills.mjs.

Runs Betaflight SITL with Betaflight's own harness (motion model, virtual GPS, RC feed) and the
same configuration as tools/sitl/sim.py, and exposes a JSON-lines control API on TCP 5790 so the
drill runner can play the safety pilot and read ground truth:

  {"cmd": "ping"}
  {"cmd": "takeoff"}                         arm in ANGLE, climb, park at hover, ALT+POS HOLD on
  {"cmd": "pilot", "roll": 1512, "hold": true, "override": true, "link": false, ...}
  {"cmd": "state"}                           truth (ENU m, heading deg) + the FC's modes and rcData
  {"cmd": "samples", "since": <epoch ms>}     the 50 Hz sample log since then
  {"cmd": "restart", "binary": "<elf>"}      FC reboot, or a swap to another Betaflight build
  {"cmd": "reset_model"}                     put the craft back on the ground at home
  {"cmd": "quit"}

UART1 (TCP 5761) is left to DroneLink; the sampler reads MSP_RC / MSP_STATUS over UART2
(TCP 5762) at 50 Hz / 10 Hz, timestamped in epoch milliseconds like the Node side.

  python3 tools/sitl/drills/drill_sim.py --bf-dir ~/betaflight [--fresh]
"""

import argparse
import json
import math
import os
import socket
import socketserver
import struct
import sys
import threading
import time

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.dirname(HERE))  # tools/sitl: sim.py, msp_override_spike.py
import msp_override_spike as spike  # noqa: E402
import sim  # noqa: E402

CONTROL_PORT = 5790
MSP_RC = 105
SAMPLE_PERIOD = 0.02
STATUS_EVERY = 5
HISTORY_S = 180


def now_ms():
    return time.time() * 1000.0


class Sampler(threading.Thread):
    """50 Hz MSP_RC + ground truth, 10 Hz MSP_STATUS. Also serves sim.take_off's monitor.get()."""

    def __init__(self, sitl, fdm, tx, msp_lock):
        super().__init__(daemon=True)
        self.sitl = sitl
        self.fdm = fdm
        self.tx = tx
        self.msp_lock = msp_lock
        self.running = True
        self.lock = threading.Lock()
        self.samples = []
        self.modes = set()
        self.arming_flags = None
        self.rc = []
        self.fix = None
        self.sats = None
        self.updated_at = None
        self.paused = False

    def run(self):
        tick = 0
        next_t = time.monotonic()
        while self.running:
            next_t += SAMPLE_PERIOD
            if not self.paused:
                try:
                    with self.msp_lock:
                        p = self.sitl.msp.request(MSP_RC, timeout=0.5)
                        rc = list(struct.unpack(f"<{len(p) // 2}H", p))
                        if tick % STATUS_EVERY == 0:
                            status = self.sitl.status()
                            g = self.sitl.msp.request(sim.MSP_RAW_GPS, timeout=0.5)
                    with self.lock:
                        self.rc = rc
                        if tick % STATUS_EVERY == 0:
                            self.modes = status["modes"]
                            self.arming_flags = status["arming_flags"]
                            self.fix, self.sats = g[0] != 0, g[1]
                        self.updated_at = time.monotonic()
                        m = self.fdm.model
                        ch = self.tx.channels
                        # [t, rcData R P Y T AUX1-4, modes, east, north, up, heading,
                        #  the SP's TX in the same order (raw AETR -> R P Y T), TX link on]
                        self.samples.append([round(now_ms(), 1), rc[:8], sorted(self.modes),
                                             round(m.pos[0], 3), round(m.pos[1], 3), round(m.pos[2], 3),
                                             round(math.degrees(m.yaw) % 360, 2),
                                             [ch[0], ch[1], ch[3], ch[2], *ch[4:8]], self.tx.streaming])
                        cutoff = now_ms() - HISTORY_S * 1000
                        while self.samples and self.samples[0][0] < cutoff:
                            self.samples.pop(0)
                except (TimeoutError, RuntimeError, OSError, struct.error, AttributeError, IndexError):
                    pass
                tick += 1
            time.sleep(max(0.0, next_t - time.monotonic()))

    # sim.take_off() reads the FC through this
    def get(self):
        with self.lock:
            age = None if self.updated_at is None else time.monotonic() - self.updated_at
            return {"modes": set(self.modes), "arming_flags": self.arming_flags, "rc": list(self.rc),
                    "fix": self.fix, "sats": self.sats, "age": age}

    def since(self, t):
        with self.lock:
            return [s for s in self.samples if s[0] > t]

    def shutdown(self):
        self.running = False


class Drill:
    def __init__(self, args):
        sys.path.insert(0, os.path.join(os.path.abspath(args.bf_dir), "src", "test", "sitl"))
        import sitl_harness
        self.h = sim.h = spike.h = sitl_harness
        sitl_harness.TELEMETRY_PORT = 0
        sitl_harness.TCP_PORT = sim.MONITOR_PORT
        self.default_binary = args.binary or os.path.join(args.bf_dir, "obj", "main", "betaflight_SITL.elf")
        self.workdir = os.path.abspath(args.workdir)
        os.makedirs(self.workdir, exist_ok=True)
        self.msp_lock = threading.RLock()
        self.sitl = self.make_sitl(self.default_binary, args.fresh)
        self.rc = sitl_harness.RcFeed()
        self.motors = sitl_harness.MotorFeed()
        self.fdm = sitl_harness.FdmFeed(self.motors)
        sim.start_sitl(self.sitl)
        self.lock_msp()
        self.motors.start()
        self.rc.start()
        self.fdm.start()
        self.sampler = Sampler(self.sitl, self.fdm, self.rc, self.msp_lock)
        self.sampler.start()
        self.pilot = sim.Pilot(self.rc)
        self.busy = threading.Lock()

    def make_sitl(self, binary, fresh):
        sitl = self.h.Sitl(binary, self.workdir)
        marker = os.path.join(self.workdir, "binary.txt")
        previous = open(marker).read().strip() if os.path.exists(marker) else None
        if fresh or previous != os.path.abspath(binary) or not os.path.exists(os.path.join(self.workdir, "eeprom.bin")):
            print(f"[drill-sim] provisioning {self.workdir}/eeprom.bin for {binary}", flush=True)
            sitl.provision(sim.sim_config())
            with open(marker, "w") as f:
                f.write(os.path.abspath(binary))
        return sitl

    def lock_msp(self):
        """sim.take_off() calls sitl.acc_calibrate() from its own thread: serialise UART2 MSP."""
        msp = self.sitl.msp
        original = msp.request
        lock = self.msp_lock

        def locked(*a, **kw):
            with lock:
                return original(*a, **kw)

        msp.request = locked

    # --- commands ---------------------------------------------------------------------

    def state(self):
        m = self.fdm.model
        p = self.pilot
        snap = self.sampler.get()
        return {
            "t": now_ms(),
            "truth": {"east": m.pos[0], "north": m.pos[1], "up": m.pos[2], "ve": m.vel[0], "vn": m.vel[1], "vu": m.vel[2],
                      "heading": math.degrees(m.yaw) % 360},
            "fc": {"modes": sorted(snap["modes"]), "arming_flags": snap["arming_flags"], "rc": snap["rc"],
                   "fix": snap["fix"], "sats": snap["sats"], "age": snap["age"]},
            "pilot": {"roll": p.roll, "pitch": p.pitch, "yaw": p.yaw, "throttle": p.throttle,
                      "arm": p.switches[spike.CH_ARM], "hold": p.switches[spike.CH_HOLD],
                      "angle": p.switches[spike.CH_ANGLE], "override": p.switches[spike.CH_OVERRIDE],
                      "link": p.link_on},
            "binary": self.sitl.binary,
        }

    def set_pilot(self, req):
        p = self.pilot
        for axis in ("roll", "pitch", "yaw", "throttle"):
            if axis in req:
                setattr(p, axis, int(req[axis]))
        for name, ch in (("arm", spike.CH_ARM), ("hold", spike.CH_HOLD), ("angle", spike.CH_ANGLE), ("override", spike.CH_OVERRIDE)):
            if name in req:
                p.switches[ch] = bool(req[name])
        p.apply()
        if "link" in req:
            p.link_on = bool(req["link"])
            self.rc.streaming = p.link_on
        return {"ok": True}

    def takeoff(self):
        with self.busy:
            self.pilot.message = ""
            sim.take_off(self.sitl, self.pilot, self.sampler)
            ok = not self.pilot.message.startswith("take-off aborted")
            return {"ok": ok, "message": self.pilot.message}

    def restart(self, binary=None):
        """Reboots the FC (or swaps the build). Closes UART1 too, as a real reboot drops USB."""
        with self.busy:
            self.sampler.paused = True
            with self.msp_lock:
                self.sitl.stop()
                time.sleep(1.0)
                self.sitl = self.make_sitl(binary or self.default_binary, False)
                sim.start_sitl(self.sitl)
                self.lock_msp()
                self.sampler.sitl = self.sitl
            self.sampler.paused = False
            return {"ok": True, "binary": self.sitl.binary}

    def reset_model(self):
        self.fdm.model = self.h.MotionModel()
        return {"ok": True}

    def handle(self, req):
        cmd = req.get("cmd")
        if cmd == "ping":
            return {"ok": True}
        if cmd == "state":
            return self.state()
        if cmd == "samples":
            return {"samples": self.sampler.since(float(req.get("since", 0)))}
        if cmd == "pilot":
            return self.set_pilot(req)
        if cmd == "takeoff":
            return self.takeoff()
        if cmd == "restart":
            return self.restart(req.get("binary"))
        if cmd == "reset_model":
            return self.reset_model()
        if cmd == "quit":
            threading.Thread(target=self.server.shutdown, daemon=True).start()
            return {"ok": True}
        return {"error": f"unknown command {cmd!r}"}

    def close(self):
        for feed in (self.sampler, self.rc, self.fdm, self.motors):
            feed.shutdown()
        self.sitl.stop()


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--bf-dir", required=True)
    ap.add_argument("--binary")
    ap.add_argument("--workdir", default="sitl-drills")
    ap.add_argument("--fresh", action="store_true")
    ap.add_argument("--port", type=int, default=CONTROL_PORT)
    args = ap.parse_args()

    drill = Drill(args)

    class Handler(socketserver.StreamRequestHandler):
        def handle(self):
            for line in self.rfile:
                try:
                    reply = drill.handle(json.loads(line))
                except Exception as exc:  # report, keep serving
                    reply = {"error": f"{type(exc).__name__}: {exc}"}
                self.wfile.write((json.dumps(reply) + "\n").encode())
                self.wfile.flush()

    class Server(socketserver.ThreadingTCPServer):
        allow_reuse_address = True
        daemon_threads = True

    server = Server(("127.0.0.1", args.port), Handler)
    drill.server = server
    print(f"[drill-sim] READY control tcp {args.port}; SITL UART1 tcp {sim.DRONELINK_PORT} for DroneLink", flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        drill.close()


if __name__ == "__main__":
    main()
