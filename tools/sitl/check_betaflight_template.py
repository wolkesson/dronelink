#!/usr/bin/env python3
"""Check docs/flight/betaflight-dronelink.cli against Betaflight SITL (issue #90).

Loads the template into a fresh SITL configuration exactly as the CLI would (plus the one
line SITL needs: the virtual GPS), then:

  1. fails on any line Betaflight's CLI rejects,
  2. reads every `set`, `aux` and `feature` line back with `get` / `aux` / `feature`,
  3. starts SITL and checks over MSP what DroneLink's identification gate checks
     (packages/air-client-sdk/src/core/FcIdentificationGate.ts): MSP API 1.48, BTFL, a
     version on the gate's allowlist, the ARM / ALTHOLD / POS HOLD / MSP OVERRIDE boxes,
     the sticks on raw channels 1-4, and the hover throttle from the template.

Usage:
  python3 tools/sitl/check_betaflight_template.py --bf-dir <betaflight checkout>
"""

import argparse
import os
import re
import shutil
import struct
import subprocess
import sys

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
TEMPLATE = os.path.join(ROOT, "docs", "flight", "betaflight-dronelink.cli")
GATE = os.path.join(ROOT, "packages", "air-client-sdk", "src", "core", "FcIdentificationGate.ts")

# What SITL needs on top of the template: there is no serial GPS, only the harness's feed.
SITL_OVERRIDES = ["set gps_provider = VIRTUAL"]

MSP_API_VERSION, MSP_FC_VARIANT, MSP_FC_VERSION = 1, 2, 3
MSP_RX_MAP, MSP_BOXNAMES, MSP_BOXIDS, MSP_GPS_RESCUE = 64, 116, 119, 135
REQUIRED_BOXES = {0: "ARM", 1: "ANGLE", 3: "ALTHOLD", 11: "POS HOLD", 50: "MSP OVERRIDE"}

failures = []


def check(ok, what, detail=""):
    print(f"  {'ok  ' if ok else 'FAIL'} {what}{f': {detail}' if detail else ''}", flush=True)
    if not ok:
        failures.append(what)


def template_lines():
    """The template's commands, comments stripped as Betaflight's CLI strips them."""
    lines = []
    with open(TEMPLATE) as f:
        for raw in f:
            line = raw.split("#", 1)[0].strip()
            if line:
                lines.append(line)
    return lines


def run_config(binary, workdir, lines):
    """Runs SITL's `--config` mode (CLI lines, then save, then exit) and returns its output."""
    path = os.path.join(workdir, "check_config.txt")
    with open(path, "w") as f:
        f.write("\n".join(lines) + "\n")
    res = subprocess.run([binary, "--config", path], cwd=workdir, capture_output=True, text=True, timeout=60)
    if res.returncode != 0:
        raise RuntimeError(f"SITL --config failed (rc={res.returncode}):\n{res.stdout}\n{res.stderr}")
    return res.stdout


def request_jumbo(sitl, cmd, timeout=2.0):
    """An MSP v1 request whose reply may be a jumbo frame (over 254 bytes, like MSP_BOXNAMES),
    which the harness's client truncates: `$M>` 0xFF cmd len16 payload checksum."""
    import time

    msp = sitl.msp
    with msp.lock:
        msp.sock.sendall(b"$M<" + bytes([0, cmd, cmd]))
        buf = msp.buf
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            start = buf.find(b"$M>")
            if start >= 0 and len(buf) >= start + 5:
                size, got = buf[start + 3], buf[start + 4]
                header = 5
                if size == 0xFF:
                    if len(buf) < start + 7:
                        size = None
                    else:
                        size, header = struct.unpack_from("<H", buf, start + 5)[0], 7
                if size is not None and len(buf) >= start + header + size + 1:
                    payload = buf[start + header : start + header + size]
                    buf = buf[start + header + size + 1 :]
                    if got == cmd:
                        msp.buf = buf
                        return payload
                    continue
            msp.sock.settimeout(max(0.01, deadline - time.monotonic()))
            try:
                buf += msp.sock.recv(4096)
            except OSError:
                pass
        raise TimeoutError(f"no MSP reply for cmd {cmd}")


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--bf-dir", required=True)
    ap.add_argument("--binary")
    ap.add_argument("--workdir", default="/tmp/dronelink_template_check")
    args = ap.parse_args()

    binary = os.path.abspath(args.binary or os.path.join(args.bf_dir, "obj", "main", "betaflight_SITL.elf"))
    shutil.rmtree(args.workdir, ignore_errors=True)
    os.makedirs(args.workdir)

    commands = [line for line in template_lines() if line != "save"]
    sets = {}
    for line in commands:
        m = re.fullmatch(r"set\s+(\S+)\s*=\s*(.+)", line)
        if m:
            sets[m.group(1)] = m.group(2).strip()
    auxes = [" ".join(line.split()) for line in commands if line.startswith("aux ")]
    features = [line.split()[1] for line in commands if line.startswith("feature ")]

    print(f"[template] {os.path.relpath(TEMPLATE, ROOT)}: {len(commands)} commands", flush=True)

    print("1. the CLI accepts every line", flush=True)
    out = run_config(binary, args.workdir, commands + SITL_OVERRIDES + ["save"])
    errors = [line for line in out.splitlines() if "ERROR" in line.upper() or "INVALID" in line.upper()]
    check(not errors, "no CLI errors", "; ".join(errors[:5]))

    print("2. the values read back", flush=True)
    readback = [f"get {name}" for name in sets] + ["aux", "feature"]
    out = run_config(binary, args.workdir, readback)
    for name, value in sets.items():
        if name in ("gps_provider",):
            continue  # replaced by the SITL override
        m = re.search(rf"^{re.escape(name)} = (\S+)", out, re.M)
        check(m is not None and m.group(1) == value, f"{name} = {value}", m.group(1) if m else "not found")
    aux_out = {" ".join(line.split()) for line in out.splitlines() if line.startswith("aux ")}
    for aux in auxes:
        check(aux in aux_out, aux)
    enabled = re.search(r"^Enabled:\s*(.*)$", out, re.M)
    for feature in features:
        check(enabled is not None and feature in enabled.group(1).split(), f"feature {feature}")

    print("3. what DroneLink's identification gate checks, over MSP", flush=True)
    sys.path.insert(0, os.path.join(os.path.abspath(args.bf_dir), "src", "test", "sitl"))
    import sitl_harness

    allowlist = re.search(r"supportedVersions:\s*\[([^\]]*)\]", open(GATE).read())
    allowed = re.findall(r'"([^"]+)"', allowlist.group(1)) if allowlist else []
    sitl = sitl_harness.Sitl(binary, args.workdir)
    sitl.start()
    try:
        msp = sitl.msp
        api = msp.request(MSP_API_VERSION)
        check(api[1] == 1 and api[2] == 48, "MSP API 1.48", f"{api[1]}.{api[2]}")
        check(bytes(msp.request(MSP_FC_VARIANT)[:4]) == b"BTFL", "variant BTFL")
        v = msp.request(MSP_FC_VERSION)
        version = bytes(v[4:4 + v[3]]).decode() if len(v) > 4 else f"{v[0] + 2000}.{v[1]}.{v[2]}"
        check(version in allowed, f"version on the gate's allowlist {allowed}", version)
        ids = list(msp.request(MSP_BOXIDS))
        names = request_jumbo(sitl, MSP_BOXNAMES).decode().rstrip(";").split(";")
        for box, name in REQUIRED_BOXES.items():
            present = box in ids and names[ids.index(box)] == name
            note = "MSP OVERRIDE is only listed when msp_override_channels_mask != 0" if box == 50 else ""
            check(present, f"mode {name} ({box})", note if not present else "")
        rx_map = list(msp.request(MSP_RX_MAP))
        check(sorted(rx_map[:4]) == [0, 1, 2, 3], "sticks on raw channels 1-4", str(rx_map[:4]))
        hover = struct.unpack_from("<H", msp.request(MSP_GPS_RESCUE), 12)[0]
        check(hover != 0 and str(hover) == sets.get("ap_hover_throttle"), "ap_hover_throttle (MSP_GPS_RESCUE)", str(hover))
    finally:
        sitl.stop()

    print(f"{'PASS' if not failures else 'FAIL'}: {len(failures)} failed", flush=True)
    sys.exit(1 if failures else 0)


if __name__ == "__main__":
    main()
