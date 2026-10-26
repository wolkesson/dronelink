# Flight control: SITL failure drills (#89)

These drills are the gate before any hardware with props: every failure of ARCHITECTURE.md §7.8, injected into the real DroneLink chain flying a Betaflight **2026.6.2** SITL craft, 10 runs each. Per-run numbers: [`drills/summary.md`](drills/summary.md) (generated) and [`drills/results.json`](drills/results.json) (raw).

## What runs

```text
Betaflight 2026.6.2 SITL ── tcp 5761 ── capture proxy (run-drills.mjs, tcp 5765: every byte, both ways, timestamped)
  │  UART2 tcp 5762: 50 Hz MSP_RC / 10 Hz MSP_STATUS sampler     └─ tools/sitl-serial-bridge.mjs (ws 5770)
  │  UDP 9002-9004: Betaflight's harness (motion model, virtual GPS, scripted safety pilot)
  │                                                                  └─ air-webapp (Vite dev, headless Chromium)
drill_sim.py: control API on tcp 5790                                     └─ WebRTC ─ ground-core-node (tcp 5771)
                                                                                         └─ ground GUI /gui (headless Chromium, keyboard)
```

- [`tools/sitl/drills/drill_sim.py`](../../tools/sitl/drills/drill_sim.py) runs SITL with Betaflight's own harness and `tools/sitl/sim.py`'s configuration, plays the safety pilot (SP), and samples the FC at 50 Hz: `rcData` (what the FC actually flies), active modes, the SP's transmitter values, and ground truth from the motion model.
- [`tools/sitl/drills/run-drills.mjs`](../../tools/sitl/drills/run-drills.mjs) starts everything else, flies each scenario through the ground GUI's keyboard (hold Enter to unlock, then W + E + R: forward, yaw right and climb), injects the fault, and checks the samples, the air's `fc-state` transitions (timestamped in the air page), the GUI, and the bytes the proxy saw.
- [`tools/sitl/drills/netimpair.py`](../../tools/sitl/drills/netimpair.py) blackholes, delays or drops loopback UDP (the WebRTC traffic) and nothing else. Delay and loss use iptables NFQUEUE: `tc netem` on `lo` would also delay the SITL links and the simulator feeds.

The SP's sticks rest at R 1512 / P 1488 / Y 1508 / T 1285: inside the hold deadbands, but distinct from the air's centered neutral (1500 / 1500 / 1500 / hover 1275). Every 20 ms sample is therefore one of three things: the FC follows the **SP**, the air's **center** (NEUTRAL or ABORTED), or the **PP**'s command.

## Running it

```sh
make -C ~/betaflight TARGET=SITL                     # Betaflight 2026.6.2, see betaflight-sitl.md
npm i -g playwright && npx playwright install chromium
pip install NetfilterQueue                            # scenario 4 (Debian/Ubuntu: apt install libnetfilter-queue-dev)
sudo node tools/sitl/drills/run-drills.mjs --bf-dir ~/betaflight --runs 10
node tools/sitl/drills/summarize.mjs > docs/sim/drills/summary.md
```

`--only 1,7,16` picks scenarios, `--headed` shows the browsers. Root is only needed for scenarios 3 and 4 (iptables); without it they are reported as skipped, never as passed. `ground-core-node` needs its usual mkcert TLS; the air webapp runs over plain `http://localhost` (`DRONELINK_DEV_HTTP=1`, still a secure context). Logs go to `sitl-drills/`. In WSL, run everything inside WSL.

## Pass criteria

Drift is measured on ground truth from 4 s after the fault (time to brake out of the commanded motion) over the next 4 s.

| Criterion | Limit |
| --- | --- |
| Air NEUTRAL after the heartbeat stops / air ABORTED after ABORT | ≤ 300 ms |
| FC sticks centered (adds one frame on the serial link and the 50 Hz sample) | ≤ 380 ms |
| Air RELEASED after the heartbeat stops | ≤ 1200 ms |
| FC back on the SP's sticks after the last frame it received: Betaflight's 300 ms freshness window, then the same next-RX-frame, RC smoothing and sampling chain as the switch flip below¹ | ≤ 450 ms |
| FC back on the SP's sticks after the SP flips the handover switch | ≤ 150 ms |
| No PP command applied after its timeout | per scenario |
| Hold: horizontal / altitude / heading drift | ≤ 2.0 m / 1.0 m / 10° |
| Transparent scenarios: injected bytes | 0, byte-identical relay |
| AUX1–4 as the FC sees them vs. the SP's transmitter | never different |

¹ The switch happens between the first sample showing the SP's sticks and the one before it. If the 50 Hz sampler itself stalled (more than 60 ms between those two samples), the earlier sample has to be within the limit instead; the check reports both.

## Scenarios

| # | Fault (how it is injected) | Expected |
| --- | --- | --- |
| 1 | GUI window `blur` (odd runs) or tab closed (even runs) | Neutral ≤ 300 ms, hovers, released ≤ 1.2 s |
| 2 | `ground-core-node` SIGKILL | Same |
| 3 | iptables DROP on loopback UDP (WebRTC) | Same |
| 4a, 4b | 500 ms / 2000 ms delay + 20 % loss per packet (NFQUEUE) | Ground gate stops the stream, the air stops applying commands on its own timeout, ends released, no runaway |
| 5 | Air page frozen 3 s (CDP `Debugger.pause`) | Betaflight's stale override hands the sticks back to the SP; after resuming, the air releases instead of flying the backlog |
| 6 | Serial bridge SIGKILL (≈ USB unplug) | Same as 5; the air reports `fc-link-lost` |
| 7 | Space in the GUI with the keys still held 3 s | ABORTED and centered ≤ 300 ms, commands ignored, hovers |
| 8 | ABORT, then the GUI tab closed | Hovers, then released and the SP has control |
| 9 | SP flips the handover switch off mid-command | SP control ≤ 150 ms, GUI shows *Safety pilot took back control* |
| 10 | SP switches POS HOLD off while the PP holds climb | Air released ≤ 300 ms after the FC drops POS HOLD; raw-throttle exposure measured |
| 11 | SP's transmitter off | Betaflight failsafe (auto-land) engages through the override |
| 12 | Air page reloaded mid-flight (switch left on) | Locked: no handover until the switch is cycled; then handover + unlock works |
| 13 | In HANDED_OVER: a rogue GUI socket streams full-deflection `fc-command`s and the GUI user holds keys | No `MSP_SET_RAW_RC` reaches the FC |
| 14a | SITL restarted mid-flight (FC reboot) | Re-identified, no `MSP_SET_RAW_RC` after the reboot, stays locked |
| 14b | Proxy swaps the FC for a scripted MSP responder identifying as Betaflight 2025.12.5 | Gate rejects, transparent, only identification probes written |
| 14c | Same, identifying as INAV | Gate rejects, transparent |
| 15 | Setting turned off in the air UI mid-command | Released and transparent ≤ 100 ms, SP control |
| 16 | Setting off; a Configurator-like client makes 300 MSP round trips over the ground TCP bridge | Byte-identical both ways, nothing written while idle |
| 17 | Setting on; the FC is a MAVLink v2 stream | Classified `mavlink-v2`, transparent, zero bytes written to it |
| 18 | All of the above | AUX1–4 never changed by the link |

14b and 14c use scripted MSP responders behind the capture proxy, so every real flight runs on Betaflight 2026.6.2; the gate decides on the identification replies alone.

Getting airborne under PP control before a fault is setup, not part of the drill. If it fails (on this loaded 2-core machine the harness occasionally blips: its Python RC feed stalls and Betaflight flags RX loss, or the air page stalls for a few hundred ms, and the air correctly releases), the run retries it once and records the retry in `results.json` and the summary. A second failure fails the scenario.

## Results

**All 20 scenarios passed 10 of 10 runs, and AUX1-4 never differed from the SP's transmitter** (201 scenario runs, Betaflight 2026.6.2 SITL, 2026-10-26). No run needed its setup retry. Per-scenario numbers are in [`drills/summary.md`](drills/summary.md). The headline figures, worst run of 10:

| What | Worst run | Limit |
| --- | --- | --- |
| Air NEUTRAL after the heartbeat stops (GUI blur/close, ground killed, blackhole) | 256 ms | 300 ms |
| FC sticks centered after the heartbeat stops | 308 ms | 380 ms |
| Air RELEASED after the heartbeat stops | 1 008 ms | 1 200 ms |
| FC back on the SP's sticks after the last frame (air frozen, USB unplugged, page reload, setting off) | 380 ms | 450 ms |
| FC back on the SP's sticks after the SP flips the switch | 77 ms | 150 ms |
| Air ABORTED / sticks centered after ABORT | 5 ms / 64 ms | 300 ms |
| GUI stops streaming at 500 ms / 2 s latency + 20 % loss | 1 024 ms / 2 191 ms | 5 000 ms |
| Air released after the FC dropped POS HOLD; raw-throttle exposure | 101 ms; 410 ms, ≤ 0.07 m climb | 300 ms; 750 ms |
| Hold drift after any fault: horizontal / altitude / heading | 0.72 m / 0.21 m / 5.3° | 2 m / 1 m / 10° |
| `MSP_SET_RAW_RC` reaching the FC before unlock, after a reboot, or to a rejected FC | 0 frames | 0 |
| Bytes injected while transparent (Configurator session, MAVLink) | 0 | 0 |

Before the fixes below, a full pass failed somewhere in roughly one run in three to five, always in a way that left the craft safe: the air released and the SP had the sticks, but later scenarios in the run could not get control again.

## What the drills found

Each of these was fixed on the drills branch and is covered by unit tests as well:

1. **werift retransmitted every lost flight-control message** (scenario 4, and every scenario after it in one run). The `flight-control` channel is `{ ordered: false, maxRetransmits: 0 }` so a stale command is dropped, not queued (ARCHITECTURE.md §7.6). werift, which terminates the ground side, tested `!!chunk.maxRetransmits`, so a value of 0 meant "reliable": under loss every lost `fc-command` was retransmitted with exponential backoff, commands arrived after the air had gone NEUTRAL, and once the backoff grew the ground->air direction stalled for good (unlocks never arrived, while air->ground state still flowed). `patches/werift+0.24.4.patch` now fixes this as aiortc (werift's origin) does, plus two neighbours: abandoning the right message's fragments, and the seconds/milliseconds mix-up in `maxPacketLifeTime` expiry. `werift-patch.test.ts` fails if the patch stops applying. The air side (Chromium) was never affected.
2. **The ground's RTT gate went blind under heavy latency** (scenario 4). It relies on the WebRTC candidate-pair RTT, which stays stale when packets are delayed by seconds: at 2 s + 20 % loss it never tripped, and at 500 ms it took 2.7 s. The GUI now also stops the stream when the air reports applying a command more than 600 ms after it was sent (`commands-late`: RTT gate + one 200 ms report interval), latched until the air releases. At 2 s + 20 % loss the air goes NEUTRAL before any late command reaches it, so the GUI also stops once a NEUTRAL report shows the last applied command older than the air's 1 s release timeout (one run in 10 had the GUI streaming for 6.2 s without it). The craft was never at risk (the air's own 250 ms / 1 s watchdog handled it), but the GUI kept streaming into a dead link.
3. **Any GUI socket closing cut off the active viewer** (scenario 13). A second tab refused as "already connected", or any probe, tore down the operator's video and `fc-state` stream when it closed; the GUI went STALE, its dead-man stopped the stream and the air released. Fail-safe, but a stray tab must not be able to do that: now only the active viewer's own socket ends its session.
4. **A reconnect could hand over without a fresh handover** (scenario 12). An air page reload, FC link reopen or setting toggle with the SP's switch left on went straight to HANDED_OVER. The supervisor now needs to see the switch go off and on (`awaiting-fresh-handover` until then).
5. **The GUI could miss *Safety pilot took back control*** (scenario 9). The supervisor went RELEASED -> IDLE on the next telemetry update once the switch was seen off, tens of ms later. RELEASED now keeps its reason until the next fresh handover and then goes straight to HANDED_OVER.
6. **Neutral detection rode the 20 Hz tick** (margins in scenarios 1-3). NEUTRAL came 250-300 ms after the last command, up to 286 ms after the fault against the 300 ms limit. A one-shot watchdog now fires at exactly the last command + 250 ms (and + 1 s for RELEASED).
7. **After a freeze, the air took the sticks back from the SP** (scenario 5). Betaflight hands control back to the SP 300 ms after the last frame, but when the frozen page resumed, the supervisor was still ACTIVE and its queued commands and ticks started sending again. While sending, a gap of more than 300 ms since the last frame now releases (`air-stalled`) instead.
8. **A frame queued before the freeze was still written after it** (scenario 5, about 1 run in 10). `FcLink` writes one frame at a time; a frame queued behind a write that was stuck across the freeze went out on resume, before the supervisor could release, and gave the PP another 300 ms. A queued `MSP_SET_RAW_RC` frame older than 100 ms is now dropped.
9. **werift expired ICE consent on a slow, lossy but working link** (scenarios 3, 4a and 4b back to back, about 1 run in 4). werift sent one consent check every 4-6 s, each aborting the previous one, and waited for its response only 2 × the last RTT (at least 500 ms). With 1-4 s of RTT every response was discarded, and through a blackhole followed by 20 % loss there were too few checks to get one through in 30 s: consent expired, werift stopped sending to the air for good (its STUN still answered the air's checks, so the air saw the link as up), and every later handover failed. The craft stayed safe (the air released on the silent heartbeat). `patches/werift+0.24.4.patch` now waits for a response until the next check is due (4 s), lets checks overlap, and checks every second once a full interval has passed without a response, as libwebrtc pings faster on a weak link. The ground now also logs the air connection's ICE state.

Measured, not a defect:

- **Late commands under loss** (4a). Commands sent before the gate keep arriving after it, because the data channel's congestion control queues them on a lossy link; the air applies them until its own neutral timeout. The check is that this ends within a bounded time (gate + 3 × delay + 500 ms) and that nothing is applied after the air's last NEUTRAL.
- **Raw-throttle exposure** (10). Between the FC dropping POS HOLD and the FC flying the SP's sticks again, the PP's climb command is a raw throttle for one Betaflight stale-override period; see the measured window and altitude change in the summary.

## Limits of this setup

- The motion model is Betaflight's crude test plant: timings and on/off behaviour are Betaflight's own and carry over to hardware; distances and drift only show trends.
- Network faults hit loopback; latency and loss are per packet in userspace, not a shaped link.
- INAV and Betaflight 2025.12 are identified through scripted responders, not real builds.
- The GUI blur is the browser `blur` event, the air freeze a debugger pause; a real WebView being killed or throttled by Android is the bench test's job (#91).
- Everything ran on one 2-core cloud VM (SITL, its Python harness, two Chromium pages, Vite and `ground-core-node`), which is where the tail of the FC fallback times (up to 380 ms against Betaflight's 300 ms window) and the occasional harness blip that the setup retry absorbs come from.
- Open item: once WebRTC has failed mid-session, neither side reconnects on its own (reconnection is deferred, ARCHITECTURE.md section 6); the air needs a reload. Finding 9 removed the way a slow link could get there, but a genuinely dead link of more than 30 s still ends that way, safely released.
- Open item: the ground relays `fc-*` messages from any GUI socket, not only the active viewer's. The air still enforces everything (scenario 13), but restricting the relay to the active viewer would be tidier.
