#!/usr/bin/env python3
"""Record an MSP reply fixture from Betaflight SITL for protocol/fixtures/ (issue #82).

Flies the SITL craft into ALT HOLD + POS HOLD with the MSP OVERRIDE switch on (the same
setup as msp_override_spike.py), then sends a fixed list of MSP requests on the SITL UART
and records the raw reply bytes exactly as received. Writes:

  <out>.bin   the reply frames, concatenated in request order (FC -> host byte stream)
  <out>.json  metadata: source, firmware, flight state, and per request its name, command,
              MSP version, raw request bytes, and the reply's offset/length in the .bin

Usage:
  python3 tools/sitl/capture_msp_fixture.py --bf-dir <betaflight checkout> \
      --out protocol/fixtures/betaflight-2026.6.2-sitl-msp
"""

import argparse
import datetime
import json
import os
import shutil
import socket
import struct
import sys
import time

import msp_override_spike as spike

REQUESTS = [
    ("MSP_API_VERSION", 1, b"", 1),
    ("MSP_FC_VARIANT", 2, b"", 1),
    ("MSP_FC_VERSION", 3, b"", 1),
    ("MSP_BOARD_INFO", 4, b"", 1),
    ("MSP_BUILD_INFO", 5, b"", 1),
    ("MSP_RX_MAP", 64, b"", 1),
    ("MSP_STATUS", 101, b"", 1),
    ("MSP_RC", 105, b"", 1),
    ("MSP_RAW_GPS", 106, b"", 1),
    ("MSP_COMP_GPS", 107, b"", 1),
    ("MSP_ATTITUDE", 108, b"", 1),
    ("MSP_ALTITUDE", 109, b"", 1),
    ("MSP_ANALOG", 110, b"", 1),
    ("MSP_BOXNAMES", 116, b"", 1),
    ("MSP_BOXIDS", 119, b"", 1),
    ("MSP_GPS_RESCUE", 135, b"", 1),
    ("MSP_STATUS_EX", 150, b"", 1),
    ("MSP_SET_RAW_RC", 200, struct.pack("<4H", 1500, 1500, spike.HOVER_THROTTLE, 1500), 1),
    ("MSP_API_VERSION", 1, b"", 2),
    ("MSP_STATUS_EX", 150, b"", 2),
    ("unassigned command 20", 20, b"", 1),
]


def crc8_dvb_s2(data):
    crc = 0
    for b in data:
        crc ^= b
        for _ in range(8):
            crc = ((crc << 1) ^ 0xD5) & 0xFF if crc & 0x80 else (crc << 1) & 0xFF
    return crc


def encode(cmd, payload, version):
    if version == 1:
        body = struct.pack("<BB", len(payload), cmd) + payload
        checksum = 0
        for b in body:
            checksum ^= b
        return b"$M<" + body + bytes([checksum])
    body = struct.pack("<BHH", 0, cmd, len(payload)) + payload
    return b"$X<" + body + bytes([crc8_dvb_s2(body)])


def read_reply(sock, version, timeout=2.0):
    """Read exactly one reply frame (success or error) and return its raw bytes."""
    buf = b""
    deadline = time.monotonic() + timeout
    header = b"$M" if version == 1 else b"$X"
    while time.monotonic() < deadline:
        start = buf.find(header)
        if start >= 0:
            if version == 1 and len(buf) >= start + 5:
                end = start + 5 + buf[start + 3] + 1
                if len(buf) >= end:
                    return buf[start:end]
            if version == 2 and len(buf) >= start + 8:
                size = struct.unpack_from("<H", buf, start + 6)[0]
                end = start + 8 + size + 1
                if len(buf) >= end:
                    return buf[start:end]
        sock.settimeout(max(0.05, deadline - time.monotonic()))
        try:
            buf += sock.recv(4096)
        except socket.timeout:
            pass
    raise TimeoutError("no MSP reply")


def capture(sitl, rc, fdm, out):
    spike.take_off_into_pos_hold(sitl, rc, fdm)
    rc.set(spike.CH_OVERRIDE, spike.h.RC_HIGH)
    spike.h.wait_for("MSP OVERRIDE box active", lambda: spike.BOX_MSPOVERRIDE in sitl.modes())
    time.sleep(1.0)

    stream = b""
    entries = []
    with sitl.msp.lock:
        sitl.msp.buf = b""
        for name, cmd, payload, version in REQUESTS:
            request = encode(cmd, payload, version)
            sitl.sock.sendall(request)
            try:
                reply = read_reply(sitl.sock, version)
            except TimeoutError:
                spike.log(f"no reply to {name} (v{version})")
                raise
            entries.append({
                "name": name,
                "command": cmd,
                "mspVersion": version,
                "request": request.hex(),
                "replyOffset": len(stream),
                "replyLength": len(reply),
            })
            stream += reply

    with open(out + ".bin", "wb") as f:
        f.write(stream)
    meta = {
        "description": "MSP v1/v2 reply frames from Betaflight SITL, one per request, concatenated in request order",
        "sourceDevice": "Betaflight SITL (TARGET=SITL), UART1 over TCP 5761",
        "firmware": "Betaflight 2026.6.2, MSP API 1.48",
        "transport": "TCP (SITL UART); no baud rate",
        "capturedAt": datetime.datetime.now(datetime.timezone.utc).isoformat(timespec="seconds"),
        "capturedWith": "tools/sitl/capture_msp_fixture.py",
        "flightState": "armed, ANGLE + ALTHOLD + POSHOLD + MSP OVERRIDE active, virtual GPS fix, hovering",
        "config": spike.spike_config(False),
        "requests": entries,
    }
    with open(out + ".json", "w") as f:
        json.dump(meta, f, indent=2)
        f.write("\n")
    spike.log(f"wrote {len(stream)} bytes, {len(entries)} replies to {out}.bin")


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--bf-dir", required=True)
    ap.add_argument("--binary")
    ap.add_argument("--workdir", default="/tmp/msp_fixture_capture")
    ap.add_argument("--out", required=True, help="output path without extension")
    args = ap.parse_args()

    sys.path.insert(0, os.path.join(os.path.abspath(args.bf_dir), "src", "test", "sitl"))
    import sitl_harness
    spike.h = sitl_harness
    sitl_harness.TELEMETRY_PORT = 0

    binary = args.binary or os.path.join(args.bf_dir, "obj", "main", "betaflight_SITL.elf")
    shutil.rmtree(args.workdir, ignore_errors=True)
    os.makedirs(args.workdir)
    out = os.path.abspath(args.out)
    spike.leg(binary, args.workdir, "capture", False, lambda s, r, f, _results: capture(s, r, f, out), {})


if __name__ == "__main__":
    main()
