# Betaflight setup for DroneLink flight control (#90)

This is how to set up a craft so the phone pilot (PP) can fly it over DroneLink in position hold, with a safety pilot (SP) on an RC transmitter bound to the FC. Do it once per craft, and again after any firmware update, `defaults`, receiver change or switch change. The flying procedure is in [`sp-pp-procedure.md`](sp-pp-procedure.md).

The settings are in a CLI template, [`betaflight-dronelink.cli`](betaflight-dronelink.cli), that you paste into Betaflight App. Most of what it sets can't be read over MSP, so DroneLink can't check it at runtime. This setup and the pre-flight checklist are what guarantee it. The design behind each value is in `ARCHITECTURE.md` section 7, and the Betaflight behaviour behind it was measured in SITL (`docs/sim/betaflight-sitl.md`, `docs/sim/flight-control-drills.md`).

## 1. Firmware

- **Betaflight 2026.6.2** (2026.6.1 is also accepted). DroneLink's identification gate only verifies a release on its allowlist (`FcIdentificationGate.ts`), and every older release, 4.5.x and 2025.12.x included, keeps applying the phone's last command for as long as the handover switch is on. A dead phone would then be a fly-away (`betaflight-sitl.md`, finding 1). 2026.6.2 is the release the SITL drills were run on.
- **Build options.** In Betaflight App's firmware flasher (cloud build), select **GPS**, **Altitude Hold** and **Position Hold**, and the magnetometer driver if the board or GPS module has one. MSP Override itself is always compiled in from 2026.6, so it isn't an option to look for.
- **Check after flashing.** CLI `version` shows `2026.6.2`. The Modes tab lists ALTHOLD and POS HOLD. MSP OVERRIDE only appears once `msp_override_channels_mask` is set (section 3), which is also how DroneLink tells that it is configured.

## 2. Sensors

| Sensor | Why |
| --- | --- |
| GPS (u-blox, on a UART set to GPS in the Ports tab) | Position hold and GPS Rescue. DroneLink only hands over with a fix and at least 8 satellites. |
| Barometer | Altitude hold. Without altitude data Betaflight doesn't engage ALT HOLD. |
| Magnetometer (recommended) | GPS position hold needs a valid heading. Betaflight has one from a calibrated magnetometer, or, without one, only after flying forward long enough for the GPS course to be trusted. Until then POS HOLD can't hold position. Calibrate it away from metal and check the heading against the real one. |

Before the first DroneLink flight, check in Betaflight App that the GPS has a 3D fix with 8 or more satellites, that the home point is set after arming, and that GPS Rescue's sanity checks don't complain (no "GPS Rescue" arming blocker, a heading that matches reality).

## 3. Applying the template

1. Get the craft flying normally first: tuned, ANGLE mode, and POS HOLD tested by the SP without DroneLink.
2. Open [`betaflight-dronelink.cli`](betaflight-dronelink.cli) and adapt the lines marked `ADAPT` (next section). In particular, run `aux` first: the template writes mode slots 0-4 and would overwrite what is there.
3. In Betaflight App's CLI tab, paste the whole file. Every line should echo without `###ERROR`. The last line, `save`, stores the configuration and reboots the FC.
4. Read it back: `get msp_override`, `get ap_hover_throttle`, `get failsafe_procedure`, `aux`, and check them against the template. Keep the output of `diff all` with the craft's records.

The template itself is checked two ways. A unit test (`packages/air-client-sdk/src/core/BetaflightTemplate.test.ts`, run in CI) keeps it consistent with what the gate and supervisor assume. `python3 tools/sitl/check_betaflight_template.py --bf-dir ~/betaflight` loads it into Betaflight 2026.6.2 SITL, reads every value back, and checks over MSP what the identification gate checks. Run that after changing the template.

## 4. What the template sets, and why

| Setting | Value | Why | DroneLink checks it? |
| --- | --- | --- | --- |
| `msp_override_channels_mask` | `15` | The phone may override roll, pitch, yaw and throttle, and nothing else. The bits are **raw receiver channels**, so 15 = channels 1-4, whatever the stick order (AETR, TAER, ...). An AUX bit would let the link touch arming or modes. Betaflight also strips the bit of the channel that carries MSP OVERRIDE. | Indirectly: MSP OVERRIDE is only listed when the mask is non-zero, and after unlock each stick must follow the phone's values or the air releases. It can't see an extra AUX bit; it never sends AUX values anyway. |
| `msp_override_failsafe` | `OFF` (default) | With `ON`, the phone's MSP stream counts as RX signal, so losing the SP's RC link would **not** trigger Betaflight's failsafe (`betaflight-sitl.md`, finding 4). | No: not readable over MSP. |
| Sticks on receiver channels 1-4 | `map` as your receiver needs | The phone's frames only carry four channels. | Yes: an RX map with a stick on an AUX channel is rejected (`unsupported-rx-map`). |
| `ap_hover_throttle` | your craft's hover throttle, e.g. `1275` | In ALT HOLD, throttle is a climb rate around this value, not around 1500. DroneLink's neutral throttle is this value, and the SP parks the throttle stick on it. `0` (capture at engage) can't be read over MSP. Set it to the throttle at which the craft actually hovers. | Yes: `0` is rejected (`hover-throttle-not-fixed`). The value itself can't be checked. |
| `alt_hold_climb_rate` | `20` (2 m/s) | Limits climb and descent. After a link loss, a climb or descent the phone was commanding carries on for up to this rate × 1 s, because alt hold leads its target (finding 7). | No. |
| `alt_hold_deadband`, `pos_hold_deadband` | `20`, `5` (defaults) | The supervisor only accepts an unlock with the SP's sticks inside these deadbands (±25 µs on roll, pitch and yaw, ±50 µs on throttle around the hover throttle). | No: not readable over MSP. The unit test keeps the tolerances inside them. |
| `feature GPS`, `gps_provider` | on, `UBLOX` | Position hold and GPS Rescue. | Indirectly: no handover without a fix and 8 satellites. |
| `gps_rescue_min_sats` | `8` | The same minimum DroneLink needs before it hands over. | No. |
| `gps_rescue_allow_arming_without_fix` | `OFF` (default) | No arming without a GPS fix, so a failsafe always has a home point. | No. |
| `failsafe_procedure` | `GPS-RESCUE` | On RC loss, stage 2 brings the craft home. | No. |
| `gps_rescue_sanity_checks` | `RESCUE_SANITY_ON` | If GPS Rescue can't work (no fix, no valid heading, not climbing, not getting closer), the craft descends in place instead. | No. |

The SITL drills (#89) flew with the same override, hover and mode settings, but with `failsafe_procedure = AUTO-LAND` (simplest to measure in the simulator) and the default `alt_hold_climb_rate`.

## 5. Modes and switches

| Mode | Template | Notes |
| --- | --- | --- |
| ARM | AUX1 high | As usual. |
| ANGLE | AUX3 high | Take off and land in ANGLE. |
| ALTHOLD + POS HOLD | AUX2 high, **one switch for both** | Both always engage together: DroneLink assumes throttle means climb rate (ALT HOLD) whenever POS HOLD is on. Betaflight refuses to arm with either switch on, so the hold switch is off at arming. |
| MSP OVERRIDE | AUX4 high | **The handover switch.** On: the phone may fly once the PP unlocks. Off: the SP flies, immediately, whatever the phone sends. |

The handover switch is the SP's main safety control, so:

- Put it on its **own switch**, used for nothing else, physically apart from ARM and the hold switch, and reachable without taking a thumb off a stick.
- A two-position latching switch is the default. A spring-loaded (momentary) switch that the SP must hold on works too and makes letting go hand control back, but it ties up a finger for the whole PP flight. Either way, OFF must be the switch's resting or obvious position. Never put it on a three-position switch shared with another mode.
- Label it on the transmitter. Practise flipping it off without looking.
- Check in the Modes tab that each switch lights only its own mode, over its whole travel.

## 6. RX failsafe

`failsafe_procedure = GPS-RESCUE` is stage 2. Stage 1 (`failsafe_delay`, default 1.5 s) holds the last sticks, then stage 2 starts. With `msp_override_failsafe = OFF` this works the same whether or not the phone is sending.

Bench-test it, **props off**, before the first DroneLink flight:

1. With props off and the craft secured, power it and connect Betaflight App. Arm it if you can do so safely on the bench; failsafe stages only run while armed. Disarmed, you can still see RX loss as the `RXLOSS` arming blocker in the Setup tab.
2. Turn the transmitter off. Betaflight must report RX loss and, armed, enter failsafe after the stage 1 delay (OSD or Configurator shows `FAILSAFE`).
3. Repeat with DroneLink connected, flight control allowed on the air unit and the handover switch on (switch it on first, then turn the transmitter off). The FC must still report RX loss and enter failsafe, and the DroneLink GUI's *RX failsafe* row must show `FAILSAFE`.
4. Turn the transmitter back on and check that the FC leaves failsafe and the SP has the sticks.

## 7. The phone's link to the FC

- **USB (the FC's USB port, a VCP).** The usual setup: the phone connects with a USB OTG cable. MSP is on by default on USB and the baud rate doesn't apply. Nothing to configure in Betaflight.
- **A USB-UART adapter on a UART.** Enable MSP at 115200 baud on that UART (Ports tab, or `serial <n> 1 115200 57600 0 115200`). The air unit (web app and Android shell) opens the port at 115200.
- On the air unit, *Allow flight control from the ground* is **off** by default. With it off, or with any FC DroneLink doesn't verify, the link is a byte-for-byte transparent relay, so Betaflight App can be used over it as before.

## 8. What DroneLink checks by itself, and what only this setup guarantees

| DroneLink checks at every connect | Only this setup and the checklist guarantee |
| --- | --- |
| Betaflight, MSP API 1.48, a release on the allowlist | `msp_override_failsafe = OFF` |
| ARM, ALTHOLD, POS HOLD and MSP OVERRIDE modes exist (MSP OVERRIDE implies a non-zero mask) | The mask covers exactly the four sticks, no AUX |
| Sticks on receiver channels 1-4 | The handover switch is alone on its own switch |
| A non-zero `ap_hover_throttle` | `ap_hover_throttle` is the real hover throttle |
| Before a handover: armed, POS HOLD on, handover switch on, no RX failsafe, GPS fix with 8+ satellites | ALTHOLD and POS HOLD on the same switch, deadbands at their defaults |
| After unlock: every stick follows the phone's values in `MSP_RC` | RX failsafe goes to GPS Rescue and was bench-tested |
