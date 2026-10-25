#!/usr/bin/env python3
"""Network faults for the SITL drills (#89): impairs loopback UDP, i.e. the WebRTC traffic
between the air webapp (Chromium) and ground-core-node, and nothing else. TCP (SITL UARTs,
the serial bridge, signaling, the ground TCP bridge) and the simulator's own UDP feeds
(ports 9000-9010) are untouched.

  netimpair.py blackhole                      drop it all (iptables DROP)
  netimpair.py delay --ms 500 --loss 20       delay every packet, drop a share (NFQUEUE)
  netimpair.py clear                          remove leftover rules

Runs until SIGTERM/SIGINT and removes its rules on exit. Needs root (iptables). `delay` needs
the NetfilterQueue Python package (pip install NetfilterQueue; Debian/Ubuntu also need
libnetfilter-queue-dev). It is used instead of `tc netem` because netem on `lo` would also
delay the TCP links and the simulator feeds, and isn't available on every kernel.
"""

import argparse
import random
import signal
import subprocess
import sys
import threading

COMMENT = "dronelink-drill"
QUEUE = 7
MATCH = ["-o", "lo", "-p", "udp", "-m", "multiport", "!", "--ports", "9000:9010", "-m", "comment", "--comment", COMMENT]


def iptables(*args, check=True):
    return subprocess.run(["iptables", *args], check=check, capture_output=True, text=True)


def clear():
    listing = iptables("-S", "OUTPUT").stdout.splitlines()
    for rule in listing:
        if COMMENT in rule:
            iptables(*(["-D"] + rule.split()[1:]), check=False)


def wait_for_signal():
    stop = threading.Event()
    for sig in (signal.SIGTERM, signal.SIGINT):
        signal.signal(sig, lambda *_: stop.set())
    stop.wait()


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = ap.add_subparsers(dest="mode", required=True)
    sub.add_parser("blackhole")
    delay = sub.add_parser("delay")
    delay.add_argument("--ms", type=float, required=True, help="added delay per packet (each direction)")
    delay.add_argument("--loss", type=float, default=0.0, help="percent of packets dropped")
    sub.add_parser("clear")
    args = ap.parse_args()

    clear()
    if args.mode == "clear":
        return
    try:
        if args.mode == "blackhole":
            iptables("-I", "OUTPUT", *MATCH, "-j", "DROP")
            print("netimpair: blackhole active", flush=True)
            wait_for_signal()
            return

        from netfilterqueue import NetfilterQueue

        def on_packet(pkt):
            if random.random() * 100 < args.loss:
                pkt.drop()
                return
            pkt.retain()
            threading.Timer(args.ms / 1000.0, pkt.accept).start()

        nfq = NetfilterQueue()
        nfq.bind(QUEUE, on_packet, max_len=65536)
        iptables("-I", "OUTPUT", *MATCH, "-j", "NFQUEUE", "--queue-num", str(QUEUE))
        print(f"netimpair: delay {args.ms:g} ms, loss {args.loss:g} % active", flush=True)
        threading.Thread(target=nfq.run, daemon=True).start()
        wait_for_signal()
    finally:
        clear()
        print("netimpair: cleared", flush=True)


if __name__ == "__main__":
    sys.exit(main())
