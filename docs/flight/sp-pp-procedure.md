# Safety pilot / phone pilot procedure (#90)

Two people fly every DroneLink flight-control session:

- **The safety pilot (SP)** holds an RC transmitter bound directly to the FC. The SP arms, takes off, lands, owns every flight mode, and owns the **handover switch** (MSP OVERRIDE). The SP can take control back at any moment, and doesn't need the phone, the network or the PP's agreement to do so.
- **The phone pilot (PP)** flies roll, pitch, yaw and climb/descend from the ground GUI, in position hold, after unlocking. The PP can't arm, disarm or change modes. Those never go over the link.

The craft must be set up as in [`betaflight-setup.md`](betaflight-setup.md). Print the checklists in sections 1 and 6 and take them to the field and the bench.

## Call-outs

Agree on these before every session and use them word for word. The SP and PP must be able to hear each other at all times (side by side, or a radio or phone call that is checked during pre-flight).

| Who | Call | Meaning |
| --- | --- | --- |
| SP | "Handing over" | About to flip the handover switch on. |
| PP | "Locked" | The GUI shows *Handed over – locked*. |
| PP | "I have control" | The unlock finished: the GUI shows *Phone pilot in control*. |
| PP | "Link warning" | The GUI shows a problem (section 4). The SP gets ready to take back. |
| PP | "Abort" | The PP pressed ABORT: the craft is hovering. |
| SP | "I have control" / "Taking back" | The SP flipped the handover switch off. The PP takes hands off the controls. |
| Either | "Land" | Stop the session: the SP takes back (if needed) and lands. |

## 1. Pre-flight go/no-go

All items must be checked. Any "no" is a no-go.

### Craft and transmitter

- [ ] Craft set up per `betaflight-setup.md`, with no configuration change since the last bench run (or a new bench run done).
- [ ] Props, frame and battery secure. Flight battery, transmitter and phone charged for the whole session.
- [ ] Transmitter on the right model. Switch positions at arming: **handover switch OFF**, hold switch (ALT + POS HOLD) OFF, ANGLE ON, ARM OFF.
- [ ] SP knows where the throttle stick sits at the hover throttle (`ap_hover_throttle`), and where the handover switch is without looking.

### Link and GUI

- [ ] Air unit connected to the FC; *Allow flight control from the ground* is on.
- [ ] Ground GUI: link shows **Flight control ready** (FC verified, Betaflight 2026.6.x).
- [ ] Go/no-go list in the GUI: *Air state current*, *Flight-control channel open*, *Flight control enabled on the air unit*, *FC verified*, *RC link ok*, *Round trip ≤ 400 ms* are green. (*Armed*, *POS HOLD active* and *Handover switch on* turn green during the flight.)
- [ ] GPS: a 3D fix with **8 or more satellites** in the GUI. After arming, the home point is set (OSD or Betaflight).
- [ ] The PP has the GUI tab focused, on a stable connection, and knows the controls: hold Enter or the *Hold to take control* ring for 1.5 s to unlock; W/S/A/D or arrows to move; Q/E yaw; R/F climb/descend; **Space or Esc = ABORT**.

### People and site

- [ ] Call-outs agreed and the voice link checked.
- [ ] Abort criteria (section 5) agreed.
- [ ] Site, airspace and the area under the planned flight are clear. Distance and height limits for the session are agreed.

## 2. Handover

1. **SP:** arm in ANGLE, take off, and climb to a safe height. Switch the hold switch on and let the craft settle in POS HOLD. Center roll, pitch and yaw, and park the throttle at the hover throttle. The GUI shows *POS HOLD active* and *Armed* green.
2. **SP:** calls **"Handing over"** and flips the handover switch on. Nothing changes in the air: the SP's sticks still fly the craft.
3. **PP:** sees *Handed over – locked* and calls **"Locked"**. Checks that the go/no-go list is all green.
4. **PP:** performs the unlock: hold Enter (or the ring) for 1.5 s. The air only unlocks if the SP's sticks are centered and the throttle is at the hover throttle; otherwise the GUI shows *unlock refused: safety pilot's sticks are not centered (throttle at hover)* and the SP re-centers. When the GUI shows *Phone pilot in control*, the PP calls **"I have control"**.

If anything is unexpected at any step, the SP flips the switch back off and the handover starts again from step 1.

## 3. During the PP's flight

- **SP:** keep the sticks centered, throttle at the hover throttle, hands on the transmitter, eyes on the craft. Any link fault gives the sticks back to the SP at their current positions, so centered sticks mean the craft keeps holding position.
- **PP:** small, smooth inputs. Releasing every key holds position; the GUI keeps sending a heartbeat while it is unlocked. Stay within the agreed distance and height. Call out anything the GUI shows (section 4).
- Neither pilot touches anything else on the air unit or the transmitter.

## 4. What the PP watches for

| GUI shows | What happened | Call / action |
| --- | --- | --- |
| *Phone pilot in control – no commands, holding position* | The air hasn't received commands for 250 ms. Center sticks are being applied. | "Link warning". Keep hands off. If it doesn't clear within a second, the air releases. |
| Dead-man message (window lost focus, tab hidden, round trip above 400 ms, commands reach the air too late, state stale) | The GUI stopped sending. The air goes to center, then releases after 1 s. | "Link warning". Don't fight it. |
| *Released – safety pilot in control (...)* | The air released (heartbeat lost, telemetry stale, POS HOLD off, GPS lost, RX failsafe, ...). | "Link warning". The SP has the sticks. The SP calls "I have control". |
| *Safety pilot took back control* | The SP flipped the handover switch off. | Hands off. |
| *Aborted – hovering* | The PP pressed ABORT. Center is applied while the heartbeat lives. | "Abort". Unlock again, or hand back. |

## 5. Takeback and abort

- **SP takeback:** the SP flips the handover switch off **at any time, without asking**, and calls **"I have control"**. Betaflight applies the SP's sticks within one RC frame (43 ms in SITL), whatever the phone sends. The PP takes hands off the controls.
- **PP ABORT:** the PP presses ABORT (button, Space or Esc) for **anything unexpected** and calls **"Abort"**. The craft hovers in POS HOLD on center sticks. Then either unlock again, or press *Hand back to safety pilot* and let the SP take back.
- **PP hand back:** at the end of the PP's flight, the PP presses *Hand back to safety pilot*. The SP flips the handover switch off and calls "I have control".

**The SP takes back immediately when:**

- the SP loses sight of the craft, or can't judge its distance or attitude;
- the craft moves in a way nobody commanded, or drifts in position hold;
- the PP calls "Link warning", "Abort", or goes silent;
- the craft approaches the agreed distance or height limit, an obstacle, or people;
- the flight battery reaches the landing reserve, or any battery warning shows;
- the RC link shows warnings (low RSSI or link quality), or the GPS loses its fix or satellites;
- weather or wind changes, or anyone enters the area;
- anything else seems wrong. When in doubt, take back.

## 6. Bench run (props off)

Do this after setting up a craft, after any firmware or configuration change, and before the first field flight. It exercises the whole chain and this procedure with nothing that can fly. **Remove the props.** Secure the craft. Work outdoors or by a window so the GPS gets 8 or more satellites; DroneLink doesn't hand over without them. Throughout, watch the GUI's *FC sticks R P Y T* row: it shows the sticks the FC is actually flying, the SP's or the phone's. (Betaflight App can't connect at the same time: in control mode DroneLink owns the FC link.)

| # | Step | Expected | OK |
| --- | --- | --- | --- |
| 1 | Connect the air unit to the FC, flight control allowed. Open the GUI. | *Flight control ready*; FC shows Betaflight 2026.6.x. | [ ] |
| 2 | Walk through the pre-flight checklist (section 1). | All items can be checked. | [ ] |
| 3 | SP arms (props off), raises the throttle to the hover throttle, and switches the hold switch on. | GUI: *Armed*, *POS HOLD active* green. | [ ] |
| 4 | SP: "Handing over", handover switch on. | GUI: *Handed over – locked*. FC sticks: still the SP's sticks. | [ ] |
| 5 | SP moves the roll stick off center; PP tries to unlock. | *Unlock refused: safety pilot's sticks are not centered*. | [ ] |
| 6 | SP re-centers; PP unlocks and calls "I have control". | GUI: *Phone pilot in control*. FC sticks: `1500 1500 1500` and the hover throttle. | [ ] |
| 7 | PP holds W, then D, Q, R. | FC sticks: pitch, roll, yaw and throttle follow, at most 150 µs from center (throttle: from the hover throttle). The *Modes* row doesn't change. | [ ] |
| 8 | SP flips the handover switch off while the PP holds a key. | FC sticks: the SP's sticks at once. GUI: *Safety pilot took back control*. | [ ] |
| 9 | Hand over and unlock again (steps 4-6). PP presses Space. | GUI: *Aborted – hovering*. FC sticks: center, even with keys held. | [ ] |
| 10 | Unlock again. PP clicks outside the GUI window. | GUI dead-man (window lost focus), *no commands, holding position*, then about 1 s later *Released – safety pilot in control (no commands from the ground)*. FC sticks: the SP's. | [ ] |
| 11 | Unlock again. Unplug the phone's USB cable. | GUI: *Released* (FC link lost). Motors (props off) go back to the SP's throttle within about 0.3 s. Plug back in: FC sticks show the SP's. | [ ] |
| 12 | Reconnect. Leave the handover switch on. | No handover: the GUI says the handover switch was already on and the SP must flip it off and on. After that, steps 4-6 work. | [ ] |
| 13 | SP switches the hold switch off while the PP is unlocked. | GUI: *Released* (POS HOLD switched off). | [ ] |
| 14 | Turn the transmitter off (props off!). | Betaflight: RX loss, then failsafe while armed. GUI *RX failsafe* row: `FAILSAFE`. | [ ] |
| 15 | Transmitter on, disarm. | Betaflight leaves failsafe; craft disarmed. | [ ] |

Record the bench run with the craft's records:

| Date | Craft | Betaflight version | Template commit | SP | PP | Result / notes |
| --- | --- | --- | --- | --- | --- | --- |
| | | | | | | |
