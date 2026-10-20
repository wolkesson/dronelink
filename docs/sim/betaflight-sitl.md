# Betaflight SITL: MSP Override spike (#81)

This spike checks the Betaflight behaviour that flight control over the mobile link (`ARCHITECTURE.md` section 7) relies on, using a real Betaflight SITL build. Most importantly, it answers the question: **does Betaflight drop the MSP override when the phone stops sending?**

**Answer: yes, from Betaflight 2026.6 onward. It does not in 2025.12 or earlier.**

## Setup

Use the latest stable Betaflight release, `2026.6.2` (MSP API 1.48). Its SITL target already includes MSP override, virtual GPS, altitude hold and position hold. No extra build flags or Gazebo are needed.

```sh
git clone --depth 1 --branch 2026.6.2 https://github.com/betaflight/betaflight.git
make -C betaflight TARGET=SITL          # -> obj/main/betaflight_SITL.elf
python3 tools/sitl/msp_override_spike.py --bf-dir betaflight --json results.json
python3 tools/sitl/msp_override_spike.py --bf-dir betaflight --diag   # per-axis link-loss runs
```

Requirements: Linux, gcc, make, and Python 3 (standard library only). `stdbuf` comes from coreutils.

`tools/sitl/msp_override_spike.py` builds on Betaflight's own SITL harness, `src/test/sitl/sitl_harness.py`, which provides:

- a crude quad motion model
- the virtual-GPS FDM feed on UDP 9003
- the RC feed on UDP 9004
- an MSP client on TCP 5761

The spike script adds two things on top:

- **The phone:** a 20 Hz `MSP_SET_RAW_RC` sender that can be killed abruptly.
- **The safety pilot (SP):** the RC feed is set up as:
  - AUX1 = ARM
  - AUX2 = ALTHOLD + POSHOLD on the same switch
  - AUX3 = ANGLE
  - AUX4 = MSP OVERRIDE (the handover switch)
  - `msp_override_channels_mask = 15` (raw AETR, no AUX)

The harness RC feed replaces the `tools/sitl-rc.mjs` emulator that #81 originally planned.

The motion model is "just enough plant for Betaflight's real rate/angle/position loops to close around". Timings and on/off behaviour are Betaflight's own and carry over to real hardware. Overshoot distances depend on the plant and only show trends.

Raw results from the full run: [`msp-override-spike-2026.6.2.json`](msp-override-spike-2026.6.2.json).

## Findings

### 1. The override drops 300 ms after the last frame (2026.6+)

`rx/msp_override.c` only uses an MSP value for a masked channel while `rxMspIsRcChannelFresh(chan)` holds. That means a `MSP_SET_RAW_RC` frame that **included that channel** must have arrived within `RX_MSP_RC_FRAME_FRESH_MS = 300` ms (`rx/msp.c`). Otherwise the channel reads the RC receiver again, one channel at a time.

Measured: the sender was killed in flight while it held pitch, yaw and climb. In five runs, `MSP_RC` was back on the SP's stick values **303, 323, 323, 311 and 311 ms** after the last frame.

| Release | Stale-override behaviour |
| --- | --- |
| 4.5.5, 2025.12.5 | **Keeps the last MSP value for as long as the switch is on.** A dead phone leaves its last command applied: a fly-away. |
| 2026.6.0-rc1, 2026.6.1, 2026.6.2 | Falls back to RX after 300 ms |

**Consequence:** the version allowlist (#93) must start at **2026.6.1**, the first non-RC release with the guard. No 2026.6.0 final tag exists. This is a hard requirement, not a preference.

### 2. Handing back control is immediate and independent of the phone

When the SP flips the handover switch off while the phone keeps streaming, `MSP_RC` is back on the SP's values within **43 ms** (one poll). Betaflight checks `IS_RC_MODE_ACTIVE(BOXMSPOVERRIDE)` on every RX update.

### 3. The link can't touch AUX channels outside the mask

A frame carrying 8 channels with ARM, the hold switch, ANGLE and OVERRIDE all at 1000 changed nothing:

- the craft stayed armed
- the holds stayed active
- `rcData` AUX1–4 kept the SP's values

Two more safeguards in Betaflight itself:

- `config.c` strips the mask bit for whichever AUX channel carries the MSP OVERRIDE switch.
- A frame shorter than a channel's index counts as not fresh for that channel.

### 4. `msp_override_failsafe` must be OFF

| `msp_override_failsafe` | RC link lost while MSP frames keep arriving |
| --- | --- |
| OFF (default) | Betaflight failsafe engages normally |
| ON | **No failsafe**: the MSP stream counts as RX signal (`rx.c`) |

ON is meant for autonomous use without an RC link. In our setup it would hide the loss of the SP's link. The identification gate can't read this setting over MSP, so it goes in the config template and the pre-flight checklist (#90).

### 5. A handover with no frames changes nothing

With the switch on and no frames sent yet, `rcData` = the SP's sticks (1500/1500/1500/1275) and the craft holds (0.0 m drift in 3 s). This is the `HANDED_OVER` (locked) state. It also means that **before the first frame, `MSP_RC` shows the SP's raw sticks**. That makes the "SP sticks centered" check possible at unlock time. Once frames flow, `MSP_RC` reports the overridden values and the SP's sticks are no longer visible.

### 6. What each axis does in ALT HOLD + POS HOLD

- **Throttle is a climb rate around the *hover throttle*, not around 1500.**
  - The deadband is `alt_hold_deadband` (default 20 %) of stick travel around `ap_hover_throttle` (default 1275). With the defaults, that's about 1220–1420 µs.
  - **Sending 1500 as "neutral" climbs** (measured 0.24 m/s in the model; Betaflight targets about 0.7 m/s).
  - The air side's neutral throttle must therefore be the FC's hover throttle.
    - `ap_hover_throttle` can be read over MSP (`MSP_GPS_RESCUE`).
    - If it's 0, Betaflight captures the throttle at the moment alt hold engages and doesn't expose that value. So require a fixed, non-zero `ap_hover_throttle`.
    - `alt_hold_deadband` and `alt_hold_climb_rate` aren't readable over MSP. The air side has to be configured with them.
- **Roll/pitch:**
  - Within `pos_hold_deadband` (default 5 %), position hold is active.
  - Beyond it, position hold is suspended and the stick flies angle mode. On release, position hold brakes and holds again. This is a velocity "nudge", not a position offset.
  - Measured: pitch 1650 for 3 s gave 1.4 m at 0.66 m/s. Released, the craft settled within 0.3 m.
- **Yaw:** a yaw rate. Position is held while yawing (0.06 m drift over a yaw of about 140°).

### 7. Where the craft ends up after link loss

Each axis was held for 3 s before killing the sender (`--diag`). Afterwards, the craft was tracked for 20 s:

| Command at link loss | Horizontal | Altitude |
| --- | --- | --- |
| pitch 1650 | stops within 0.6 m, then holds within 0.1 m | +0.8 m slow settle (model) |
| yaw 1650 | 0.06 m | −0.4 m settle |
| throttle 1600 | 0 m | **+4.6 m over ~16 s, then holds** |
| pitch + yaw + throttle | overshoots 5.4 m, returns to 0.6 m | +3.5 m, then holds |

There is no runaway in any case. Two bounded effects to design for:

- **Altitude.** While a climb is commanded, alt hold moves its *target* ahead of the craft. The lead is capped at `alt_hold_climb_rate` × 1 s, which is 5 m at the default 5 m/s (`altHoldUpdateTargetAltitude`). After link loss the craft completes that banked change and then holds. Lowering `alt_hold_climb_rate`, and limiting the phone's throttle deflection, shrinks the bound.
- **Horizontal.** The overshoot grows with the speed at the moment of loss. After five back-to-back forward bursts at 4.8 m/s it was 11 m, before returning. Limiting the roll/pitch deflection limits the speed and therefore the overshoot.

These magnitudes depend on the plant. The bench and field tests (#91, #92) must measure them on the real craft.

### 8. What the identification gate (#93) can and can't see over MSP

| Need | Over MSP? |
| --- | --- |
| Variant `BTFL` | `MSP_FC_VARIANT` |
| Version | `MSP_FC_VERSION`: year − 2000, month, patch, then a version string (e.g. `26 6 2 "2026.6.2"`) |
| MSP OVERRIDE compiled in **and** mask ≠ 0 | `MSP_BOXIDS` contains 50 only when `msp_override_channels_mask` ≠ 0 (`msp_box.c`) |
| POS HOLD / ALT HOLD available | `MSP_BOXIDS` contains 11 / 3 |
| Exact mask value | **No.** Check functionally (only the stick channels follow the override in `MSP_RC`) or by operator confirmation |
| Channel map | `MSP_RX_MAP`. The mask bits and `MSP_SET_RAW_RC` both use **raw receiver channel order**, not Betaflight's internal RPYT order |
| `ap_hover_throttle` | `MSP_GPS_RESCUE` (u16 at offset 12) |
| `msp_override_failsafe`, `alt_hold_deadband`, `alt_hold_climb_rate` | **No.** Use the config template + checklist (#90) |

## Effects on the design

These findings are applied to `ARCHITECTURE.md` section 7:

- Version allowlist ≥ 2026.6.1 (finding 1).
- `msp_override_failsafe = OFF` is required (finding 4).
- Neutral throttle = the FC's `ap_hover_throttle`, which must be fixed and non-zero (finding 6).
- The post-link-loss altitude and horizontal overshoot bounds, and the config that limits them (finding 7).
- The SP's sticks can be checked before unlock (finding 5).
- Gate details from finding 8.

The FC-side 300 ms fallback is shorter than the air side's 1 s release timeout. So when the phone itself dies, Betaflight hands control back to the SP before the air-side watchdog would have.
