# DroneLink — Architecture & Development Plan

Status: draft v3

## 1. Goals & constraints

- Air side reads FC telemetry/control over USB serial and captures phone/desktop camera media, forwarding both to the ground over WebRTC.
- Ground side terminates signaling/WebRTC, bridges the serial byte stream to TCP for INAV Configurator/GCS, and records or re-serves video.
- The byte path remains protocol-agnostic end-to-end.
- The repository is split by **concern**, not only by ground vs air, so shared transport and pairing logic live below thin app shells.

## 2. Package graph

```text
packages/
  core-transport/
    pairing/token protocol
    TLS material helpers (mkcert / Tailscale)
    shared transport primitives
  ground-client-sdk/
    signaling server
    ground-side WebRTC peer
    TCP bridge
    video sink runtime
  air-client-sdk/
    pairing session client
    QR scanner
    browser WebRTC session manager
    serial transport abstractions
  fc-msp/
    MSP v1/v2 framing (streaming parser, encoders)
    Betaflight message set for flight control
  ui-kit-shared/
    shared UI-facing presentation helpers
  ui-kit-ground/
    ground-only UI-facing scaffold

apps/
  ground-core-node/
    headless runtime that composes ground-client-sdk only
  ground-web-client/
    ground UI composition scaffold
  air-webapp/
    air-side PWA composition shell
```

### Dependency direction rule

- `core-transport` is the base layer.
- `ground-client-sdk` and `air-client-sdk` depend on `core-transport`.
- `ui-kit-shared` and `ui-kit-ground` stay presentation-only and do not import SDK internals.
- `apps/*` compose packages and should not own business logic.

This mirrors the Android-shell principle: keep shells thin and keep durable logic in shared layers.

## 3. Key design decisions

- **Signaling remains part of the ground runtime.** No separate signaling deployment.
- **Pairing/authentication stays QR/manual token based.** The WebSocket token exchange is the enforceable authorization gate.
- **TLS trust remains out-of-band.** `mkcert` or Tailscale-issued certs are still the supported trust paths; browser-side cert pinning is still not possible.
- **Byte relay stays protocol-agnostic.** MSP/MAVLink parsing does not belong in `core-transport`.
- **Air serial access stays abstracted.** `WebSerialTransport` is the desktop implementation; `NativeBridgeTransport` is the Android WebView path, backed by `android-shell`'s native USB bridge.

## 4. Runtime mapping

| Runtime | Packages composed |
| --- | --- |
| `@dronelink/ground-core-node` | `@dronelink/core-transport`, `@dronelink/ground-client-sdk` |
| `@dronelink/air-webapp` | `@dronelink/core-transport`, `@dronelink/air-client-sdk`, `@dronelink/ui-kit-shared` |
| `@dronelink/ground-web-client` | `@dronelink/core-transport`, `@dronelink/ground-client-sdk`, `@dronelink/ui-kit-shared`, `@dronelink/ui-kit-ground` |

## 5. Development and CI

- The repo root is an npm workspace containing `apps/*` and `packages/*`.
- `ground-ci.yml` runs root `npm ci`, then builds/tests the ground-side and shared workspaces.
- `webapp-ci.yml` runs root `npm ci`, then builds/tests the air-side and shared workspaces.
- `android-ci.yml` runs root `npm ci` to build the `air-webapp` PWA bundle, runs `android-shell`'s Kotlin unit tests with Gradle (JDK 17), then builds the debug APK and uploads both the test report and the APK as workflow artifacts.
- Lint remains advisory in the npm-based workflows; `android-ci.yml` has no lint step yet (see the workflow file).
- Local development TLS still uses `mkcert` for the air app and either `mkcert` or `tailscale cert` for the ground runtime.

## 6. Current implementation state

### Complete
- Pairing/token flow and the WebRTC data channel
- End-to-end FC → WebRTC → TCP bridge path
- Workspace split into shared transport, air SDK, ground SDK, and app shells
- Air-side camera source selection/live preview, ground-side video recording, and the live video GUI
- Ground-initiated video quality control (Auto/High/Low/Data-only) via the `video-control-request`/`video-control-state` signaling messages
- Ground-initiated camera source switching: air publishes its enumerated camera list (`control: "camera-source-list"`) once connected and after every switch; the ground GUI offers those devices, and a selection is relayed as a `control: "camera-source"` request, applied via the same `WebRtcSessionManager.replaceVideoTrack`/`addVideoTrack` path the local device picker uses
- Air-unit battery status: air watches the Battery Status API (`startBatteryMonitor`) and sends an unsolicited `air-status` message (`protocol/schemas/air-status.schema.json`) on connect and on every level/charging change; ground relays it to the GUI, caches the latest to replay to a viewer that attaches later, and blanks it when air disconnects. The GUI shows it as a percentage, warning at 20% (low) and 10% (critical) when not charging
- Air-unit mobile data usage: the same `air-status` message carries `dataUsage` (cumulative WebRTC payload tx/rx bytes, sampled from `getStats()` once a second and accumulated across peer-connection restarts). Measured on air because the phone is what's on the metered link; the GUI derives the current rate from successive samples and shows the session total. It excludes IP/DTLS overhead and signaling, so the carrier's figure will be somewhat higher
- Ground-initiated video flip/rotation (horizontal/vertical mirroring, 90-degree-step rotation), for when the phone can't be mounted in the correct orientation: the ground GUI's flip checkboxes and rotate-left/rotate-right buttons send `control: "flip"`/`control: "rotate"` requests; air redraws the camera feed onto a canvas with the combined mirror/rotate 2D transform and swaps the canvas's `captureStream()` track into the sender via `replaceVideoTrack`, since raw camera tracks and `RTCRtpSender` have neither capability. The canvas always keeps the source's own width/height (rotated content is letterboxed to fit rather than swapping dimensions), so no resolution desync — see the known limitation below
- Ground-initiated zoom-to-fill: a "Zoom to fill" checkbox next to the flip controls sends a `control: "fill"` request. Like flip/rotate it is applied air-side in the canvas pipeline (and saved per camera), so the ground recording gets it too: a 90/270 rotation is scaled to cover the unchanged landscape frame (cropping the picture's top and bottom) instead of pillarboxed inside it. At 0/180 the picture already fills the frame, so it has no effect there. The ground GUI's `<video>` itself always shows the whole received frame (`object-fit: contain`)
- Air-side camera settings persistence (`CameraSettingsStore`, `localStorage`-backed): per-camera flip/rotation is saved on every applied `flip`/`rotate` control and restored on every `switchCameraTo()` for that camera, instead of carrying the previously active camera's transform over to a different one. A default camera, set from the ground GUI's "Set as default" button (`control: "camera-set-default"`), is opened automatically the next time the air webapp loads and enumerates devices — before any ground station has paired, and confirmed surviving a real force-stop/relaunch — and is included in the `camera-source-list` push (`defaultDeviceId`) so the ground GUI can show which one it is. Since each camera can have its own saved transform, `camera-source-list` also carries the newly-active camera's actual flip/rotation (`activeTransform`) on every push, so the ground GUI's flip checkboxes/rotation label follow a switch instead of showing the previous camera's stale value (and the rotate buttons computing off it). Keyed by the camera's own **label**, not `MediaDeviceInfo.deviceId` — confirmed against a real Android WebView, `deviceId`/`groupId` are salted fresh on every page load there, so only `label` stays stable across the reload/restart/reboot this store needs to survive (`android-shell`'s local server also had to move off an OS-assigned port to a fixed one for the same reason — see `android-shell/README.md`). All of this lives on the air unit, not synced ground-to-ground, since it describes how *this* phone is physically mounted, not a per-pairing preference
- `android-shell`: WebView shell + localhost PWA host, camera/mic permission passthrough, foreground service/wake lock/autostart, and the USB host serial bridge (`NativeBridgeTransport`) — validated end-to-end on real hardware (unattended reboot autostart, the FC/camera/WebRTC pipeline, ground pairing, INAV Configurator over the TCP bridge, and a 45+ minute soak session)

The video control messages (`protocol/schemas/video-control-request.schema.json`, `video-control-state.schema.json`) are deliberately shaped as a `control`-discriminated envelope, with `"quality"`, `"camera-source"`, `"camera-set-default"`, `"flip"`, `"rotate"`, and `"fill"` implemented today (plus `"camera-source-list"`, air's unsolicited device-list push, on the state side only). Further ground-initiated video controls — zoom, gain/contrast — are expected to be added as new `control` cases in `air-client-sdk`'s `WebRtcSessionManager` and new GUI widgets, without renaming the protocol or changing `ground-client-sdk`'s relay code, which stays agnostic to the payload shape: adding camera-source, camera-set-default, flip, rotate, and fill each required zero changes to `ground-client-sdk`, confirming the design.

Camera capture (`getUserMedia`, device enumeration) is owned by `air-webapp`'s app layer, not `air-client-sdk` — the SDK stays transport-only and exposes `setCameraSourceHandler()` for the app to register its own switch logic (`switchCameraTo()` in `app.ts`), the same separation the local device-picker dropdown already relied on. Flip and rotate follow the same split: `setFlipHandler()`/`setRotateHandler()` let the app own the actual frame transform (`video-transform.ts`'s combined mirror/rotate canvas re-render pipeline) while the SDK only dispatches each request and reports the handler's ok/error outcome. `setCameraDefaultHandler()` follows the same pattern for `camera-set-default` — the SDK only dispatches; `app.ts` validates the deviceId and writes it via `CameraSettingsStore`, which (unlike the transport-only SDK) is deliberately a browser-storage wrapper living in `air-client-sdk` anyway, the same call as `BatteryMonitor`: both wrap a raw browser API (`localStorage`, `navigator.getBattery`) behind a small interface the app composes, rather than being session/protocol logic themselves.

### Known limitation

`android-shell`'s USB connection now lives in `AirShellForegroundService` (via `UsbSerialSession`), not `MainActivity` — backgrounding/recreating the Activity no longer tears down the USB link, since `NativeSerialBridgeController` just attaches/detaches a listener to the already-running session instead of owning the `UsbSerialBridge` itself. This has been through unit tests and a full Gradle build but not yet a real-device pass (Activity recreation with USB alive, cold-start-still-requires-a-tap, hot replug, no-WebView-attached — see `android-shell/README.md`'s USB testing steps); treat it as implemented but not yet hardware-validated.

Mid-session video source switching (`WebRtcSessionManager.replaceVideoTrack`, air-webapp's device picker while connected) swaps the outbound `MediaStreamTrack` in place via `RTCRtpSender.replaceTrack` and skips renegotiation entirely. The ground side has no way to learn about the swap: its `MediaRecorder` is sized once from the `videoWidth`/`videoHeight` signaled in the original SDP offer (`ground-client-sdk`'s `webrtc.ts`) and never re-reads dimensions afterward. Switching to a source with a different resolution mid-session will desync the recorder from the actual frame size and can corrupt the recording — only same-resolution swaps are safe today. The ground-initiated "Low" video quality preset (see below) has the same failure mode: it changes the encoded frame size via `scaleResolutionDownBy` with no renegotiation, so it desyncs the *recorded file's* container metadata the same way (the live GUI viewer is unaffected — it's a raw RTP relay with no static dimension metadata). Fixing this needs a new signaling message so the ground side can resize or restart the recorder when the source changes.

### Deferred
- Ground-side GUI features beyond the live video viewer and the flight-control panels in section 7
- ESP32 bridge firmware and iPhone air-side support
- Reconnection/resilience work (the flight-control watchdogs in section 7 are not general reconnection logic)
- Docker/deployment work

## 7. Flight control over the mobile link (design)

Status: design accepted for milestone "Mobile flight control in position hold" (epic #79, this section is #80). Implemented so far: the MSP library (#83), the flight-control channel (#84), link detection and the identification gate (#93), the `FcLink` arbiter with the telemetry poller (#85), the safety supervisor (#86), and the ground GUI's telemetry and control panel (#87, #88). Betaflight behaviour stated here was verified against Betaflight 2026.6.2 SITL in the #81 spike; see [`docs/sim/betaflight-sitl.md`](docs/sim/betaflight-sitl.md) for method, measurements and source references. Items still marked *(SITL)* are tuning values for the SITL drills (#89).

### 7.1 Scope

A phone pilot (PP) in the ground web GUI flies a Betaflight multirotor in GPS **Position Hold** over the existing WebRTC link: pitch (forward/back), roll (left/right), yaw and throttle (climb/descend around the hold altitude). Arming, disarming and flight-mode changes are **never** possible over the link. A safety pilot (SP) on an RC transmitter bound directly to the FC is mandatory in this phase.

Hard requirements:

- No failure of the mobile link, WebRTC session, browser tab, phone app or phone↔FC USB link may lead to a fly-away. Every failure ends in one of two states: the craft **hovers in Position Hold**, or the **SP has control**.
- Flight control is **opt-in** and the serial link is **fully transparent** unless it is both enabled and talking to a verified, supported Betaflight FC (§7.3).

### 7.2 Roles and handover

| Who | Owns |
| --- | --- |
| Safety pilot (RC, bound to the FC) | Arming, flight modes, the **handover switch** (`MSP OVERRIDE` mode on its own AUX switch), and all four sticks whenever the override is not applied |
| Phone pilot (ground GUI) | Roll/pitch/yaw/throttle after an explicit unlock, the ABORT button, handing back |

Sequence: SP arms, takes off and stabilises in POS HOLD with sticks centered → SP flips the handover switch → GUI shows *Handed over – locked* (SP sticks still fly the craft; air sends nothing) → PP completes the **unlock manoeuvre** → PP has control. The SP takes back control at any time by flipping the switch back; Betaflight stops applying the override as soon as the box is off, so this needs no cooperation from the phone or network.

The **unlock manoeuvre** is a press-and-hold of the *Take control* control for 1.5 s with a visible progress ring (mouse, touch, or a held key). A click, tap, or key press shorter than the hold never unlocks. Control re-locks on ABORT, on any transition to `NEUTRAL`→`RELEASED`, when the SP takes back control, on data-channel reopen, and on FC re-identification.

**ABORT** is always visible while the PP is unlocked (also Space/Esc). It immediately sets all four sticks to center and keeps sending center, so the craft hovers in POS HOLD; further commands are ignored until a new unlock. A secondary *Hand back* action sends `release`, after which the air stops overriding and the SP's sticks apply.

### 7.3 Opt-in, link detection and the transparency guarantee

- `flightControlEnabled` is an air-unit setting, persisted in browser storage next to `CameraSettingsStore`, **default off**. It can be changed from the air UI or the ground GUI (via the `flight-control` channel), but a change from the ground is only accepted while the supervisor is `IDLE` or `RELEASED`. Turning it off in any state forces `RELEASED` and returns the link to transparent passthrough.
- **Passive link-type detection** always runs: a read-only tap on the FC→air byte stream classifies it as `msp-v1`, `msp-v2`, `mavlink-v1`, `mavlink-v2`, `crsf`, `unknown` or `silent`. It never writes, delays or consumes bytes.
- **Active identification** (§7.5) only runs when the setting is on, the passive classification does not contradict MSP, and the passthrough is idle (no ground→FC serial-relay bytes for 2 s). Its requests and replies never reach the ground.
- **Transparency guarantee:** unless the setting is on *and* identification returned `verified`, the serial path is byte-identical to today's relay in both directions — nothing injected, consumed, reordered or delayed. This covers the setting being off, INAV, ArduPilot/MAVLink, other MSP firmware, unsupported Betaflight versions, unknown protocols, timeouts and malformed replies. The existing "byte relay stays protocol-agnostic" decision therefore still holds for every non-flight-control use.
- **Exclusive ownership while in control mode:** once the link leaves transparent mode, the passthrough is **suspended in both directions** (ground→FC bytes are dropped and counted, FC→ground bytes are not forwarded), and the ground GUI shows *Passthrough suspended – flight control active*. Read-only forwarding was rejected: Configurator would see replies to requests it never sent. Passthrough resumes when the supervisor is back in `IDLE`/`RELEASED` and the setting is turned off, or the FC link is reopened.

### 7.4 Betaflight mechanism

- Betaflight **MSP Override** (`USE_RX_MSP_OVERRIDE`, included in standard and SITL builds) with the `MSP OVERRIDE` mode on the SP's handover switch. **Minimum Betaflight 2026.6.1** — see stale override below.
- `msp_override_failsafe` **must be OFF** (the default): when ON, an MSP stream counts as RX signal and hides the loss of the SP's RC link from Betaflight's failsafe (verified in SITL). It is not readable over MSP, so it is enforced by the config template and pre-flight checklist (#90).
- `msp_override_channels_mask` = roll + pitch + yaw + throttle, **never any AUX channel**, so arming and mode changes over the link are impossible by construction. The air additionally only ever writes the four stick channels in `MSP_SET_RAW_RC` (cmd 200), mapped through the FC's `MSP_RX_MAP`: both the mask bits and the `MSP_SET_RAW_RC` payload use raw receiver channel order, not Betaflight's internal RPYT order. Verified in SITL: a frame that also carries AUX values (including ARM low) changes nothing outside the mask.
- Per-axis meaning in ALT HOLD + POS HOLD (both boxes on the SP's hold switch): roll/pitch inside `pos_hold_deadband` (5 %) = hold; beyond it position hold is suspended and the stick flies angle mode, braking back into a hold on release (a velocity nudge, not a position offset). Yaw = yaw rate, position held while yawing. Throttle = climb/descend rate outside `alt_hold_deadband` (20 % of travel) around **`ap_hover_throttle`, not 1500** — 1500 is above the deadband with defaults and climbs. The air's neutral throttle is therefore the FC's hover throttle, read from `MSP_GPS_RESCUE`; `ap_hover_throttle` must be set to a fixed non-zero value (0 means "capture at engage", which is not readable over MSP). Centered sticks (throttle at hover throttle) = hold position, heading and altitude.
- Stale override: from 2026.6 Betaflight only applies an MSP value to a masked channel while a frame containing that channel arrived within 300 ms (`RX_MSP_RC_FRAME_FRESH_MS`); otherwise the channel reads the RC receiver again. Measured in SITL: 303–323 ms from the last frame to the SP's values in `MSP_RC`. **4.5.x and 2025.12.x keep the last MSP value indefinitely**, which would turn a dead phone into a fly-away — hence the 2026.6.1 minimum. This is the FC-side layer of §7.7 and the reason the SP keeps the sticks centered (throttle at the hover point) while the PP flies.
- Handback: turning the handover switch off returns the SP's values on the next RX update (43 ms in SITL), whatever the phone keeps sending.
- After link loss the craft settles into a hold, with two bounded effects (SITL, plant-dependent magnitudes): a commanded climb/descent continues by up to `alt_hold_climb_rate` × 1 s, because alt hold moves its target ahead of the craft while the stick is deflected; and the horizontal overshoot grows with the speed at the moment of loss. Both are limited through `alt_hold_climb_rate` and the per-axis deflection limits (§7.9).

### 7.5 FC identification gate

Runs on every FC link (re)open, after a detected FC reboot (uptime reset in `MSP_STATUS_EX`), and when the setting is turned on. Result: `transparent(reason)` | `pending` | `verified`. Any failure, timeout or malformed reply is `transparent`.

1. `MSP_API_VERSION` within the supported range.
2. `MSP_FC_VARIANT` = `BTFL`.
3. `MSP_FC_VERSION` (year − 2000, month, patch, then the version string) in an **allowlist** (configuration, not code) containing only releases ≥ 2026.6.1 that passed the SITL drills and the bench test.
4. `MSP_BOARD_INFO` / `MSP_BUILD_INFO` logged.
5. `MSP_BOXIDS` contain ARM (0), ALTHOLD (3), POS HOLD (11) and MSP OVERRIDE (50); the box bit positions are resolved here rather than hard-coded. Betaflight only lists MSP OVERRIDE when `msp_override_channels_mask` is non-zero, so its presence proves both the build option and a configured mask.
6. `MSP_RX_MAP` read to map axes to raw channel indices. The four sticks must map to raw channels 0–3 (any permutation); a map that puts a stick on an AUX position → `transparent(unsupported-rx-map)`, since the air's 4-channel frame could not reach it.
7. `ap_hover_throttle` read from `MSP_GPS_RESCUE`; zero (capture mode) → `transparent(hover-throttle-not-fixed)`.
8. Override mask covers the four stick channels: not readable over MSP, so checked functionally on the first frames after unlock (each stick channel must follow the override in `MSP_RC`; any mismatch → `RELEASED` and transparent) and confirmed by the operator against the config template. AUX bits in the mask cannot be exploited: the air only ever sends a 4-channel frame, and Betaflight treats channels beyond the frame's length as stale, so they keep the SP's values.

No `MSP_SET_RAW_RC` frame is ever written before `verified`. An identity change during a session forces `RELEASED` and re-identification.

### 7.6 Control path and messages

```text
ground GUI ──WS──> ground-core-node ──RTCDataChannel "flight-control"──> air supervisor ──MSP_SET_RAW_RC──> FC
           <──────────────────────── flight-control-state (5–10 Hz + on change) <────────── MSP telemetry poller
```

- A dedicated `flight-control` RTCDataChannel (`ordered: false`, `maxRetransmits: 0`), created by air next to `serial-relay`, so a stale command is dropped rather than queued behind serial traffic. Ground only routes it by message `type` (GUI → air: `fc-command`/`fc-control`/`fc-setting`; air → GUI: `fc-state`), like the video-control relay, and tells the GUI when the channel opens or closes (`fc-channel { open }`). Losing the channel does not end the session the way losing `serial-relay` does: video and the serial link carry on. It also carries state while the link is transparent, so the GUI can show the link type and the setting. **Implemented (#84):** the schemas, the channel on both sides, and the ground relay. The shared types and validators live in `core-transport`'s `flight-control.ts`; the air side validates every ground message and counts the ones it rejects.
- Commands: `fc-command { seq, sentAt, roll, pitch, yaw, throttle }` normalised to [-1, 1] around neutral (1500 for roll/pitch/yaw, the FC's hover throttle for throttle); `fc-control { action: unlock | abort | release }`; `fc-setting { flightControlEnabled }`. Air drops any command with `seq` ≤ the last applied one. On an unreliable channel a lost message is gone, so `fc-control` and `fc-setting` are idempotent and the GUI resends them until `fc-state` reflects them. Ground answers them with an error while there is no channel; it drops `fc-command` silently, since the air's watchdog is meant to see that silence.
- State (air → ground): setting, link mode and detected link type, FC identity, supervisor state and last transition reason, handover/lock status, last applied `seq`, FC telemetry (armed, modes, RX failsafe, GPS, altitude, vario, heading, attitude, voltage) and the configured limits. Schemas live in `protocol/schemas/` (#84).
- In control mode, `MSP_SET_RAW_RC` has priority on the serial link; telemetry polling uses the remaining budget round-robin.
- **Command stream as heartbeat:** while the PP is unlocked (including `ABORTED`), the GUI sends `fc-command` at 20 Hz continuously — zeros when no key is held. Releasing a key only zeroes that axis; it does not stop the stream. The stream stops only on a ground dead-man trigger (window blur, tab hidden, WebSocket to `ground-core-node` lost, RTT above the gate). The air therefore reads silence as a link/UI failure, never as "the PP is hovering".

### 7.7 Supervisor state machine (air)

| State | Sends to FC | Entered when |
| --- | --- | --- |
| `IDLE` | nothing | start, or preconditions not met |
| `HANDED_OVER` | nothing (SP still flies) | all preconditions met, incl. MSP OVERRIDE box active |
| `ACTIVE` | latest command, clamped and slew-limited, at 20 Hz | `unlock` received in `HANDED_OVER`, or fresh command in `NEUTRAL` |
| `NEUTRAL` | all four sticks center | no valid command (heartbeat lost) for 250 ms |
| `ABORTED` | all four sticks center; commands ignored | `abort` in `ACTIVE`/`NEUTRAL` |
| `RELEASED` | **nothing** (FC falls back to the SP's RC) | see below |

Preconditions (checked continuously; losing any one from any state → `RELEASED`): setting on, identification `verified`, FC armed, POS HOLD active, MSP OVERRIDE active, GPS fix with enough satellites, no RX failsafe, FC link healthy (an MSP reply within 500 ms), `flight-control` channel open, air page visible.

`RELEASED` is also entered after 1 s without any valid command (in `NEUTRAL`, or in `ABORTED` — an aborted craft with a live heartbeat keeps hovering), on `release`, and when the setting is turned off. From `RELEASED` the craft can only be controlled again via a fresh handover and unlock. Leaving POS HOLD is treated with particular care: outside POS/ALT HOLD an overridden throttle is a raw motor command, so the supervisor stops sending in the same tick it sees the mode drop; the residual exposure is bounded by the FC's 300 ms stale-override timeout (in SITL a held 1600 throttle climbed 1.7 m in the first second after the holds were switched off while the phone kept sending).

`unlock` is additionally refused unless the SP's sticks are at neutral (roll/pitch/yaw within the pos-hold deadband of 1500, throttle within the alt-hold deadband of the hover throttle). This is checkable because in `HANDED_OVER` no frame has been sent yet, so `MSP_RC` still reports the SP's raw sticks; once frames flow it reports the overridden values.

All timing logic takes an injected clock, so every transition is unit-testable with fake timers.

### 7.8 Fail-safe matrix

| Failure | Expected result | Guaranteed by |
| --- | --- | --- |
| Ground GUI tab closed, blurred or hidden | Center within 250 ms, then SP control after 1 s | GUI dead-man; air neutral/release timeouts |
| Ground↔air network loss or WebRTC restart | Same | Air timeouts; channel close → `RELEASED` |
| High latency / loss | Commands withheld while RTT > 400 ms or commands arrive > 600 ms late; air goes neutral | Ground RTT and command-age gates; air timeouts |
| Air tab frozen, WebView throttled, app killed | SP's RC values take over; after resuming, the air releases instead of taking control back | FC stale-override fallback; supervisor `air-stalled`; `FcLink` drops RC frames queued before the stall |
| USB unplugged, FC link lost | SP's RC values take over | FC stale-override fallback; air `fc-link-lost` → `RELEASED` |
| FC reboot or identity change | FC disarms on reboot; air releases and re-identifies | Identification gate |
| `flightControlEnabled` turned off | SP control, then transparent | Supervisor |
| ABORT pressed | Hover in POS HOLD until a new unlock | Supervisor `ABORTED` |
| SP flips the handover switch back | SP control immediately | Betaflight (override box off) |
| SP leaves POS HOLD | Air stops sending; SP control | Supervisor precondition; FC fallback |
| GPS loss during POS HOLD | Air releases; SP control (Betaflight's own POS HOLD fallback applies) | Supervisor precondition |
| RC link loss | Betaflight RX failsafe (GPS Rescue or land), unaffected by the override | Betaflight |
| Commands before unlock | Never reach the FC | Supervisor `HANDED_OVER` |

### 7.9 Limits and timings

Defaults below are configurable and are to be justified in the SITL drills (#89) before any hardware flight. The FC-side 300 ms fallback is shorter than the air's 1 s release timeout, so when the phone itself dies Betaflight hands back to the SP before the air watchdog would.

| Parameter | Default |
| --- | --- |
| Command rate (ground and air) | 20 Hz |
| Air neutral timeout | 250 ms |
| Air release timeout (neutral/aborted with link lost) | 1 000 ms |
| FC link health timeout | 500 ms |
| Air stall release (gap since the last frame written while sending) | 300 ms |
| Max age of a queued `MSP_SET_RAW_RC` frame before it is dropped | 100 ms |
| Ground command-age gate while `ACTIVE` (RTT gate + one report interval) / while `NEUTRAL` | 600 ms / 1 000 ms |
| Ground RTT gate | 400 ms |
| Max deflection: roll/pitch, yaw | ±150 µs around 1500 |
| Max deflection: throttle | ±150 µs around `ap_hover_throttle` |
| Recommended `alt_hold_climb_rate` (bounds post-loss altitude change) | 20 (2 m/s) |
| Slew limit | full range in 500 ms |
| Unlock hold time | 1.5 s |
| Passthrough idle time before active identification | 2 s |

### 7.10 Code placement

- New `packages/fc-msp`: pure TypeScript MSP v1/v2 parser/encoder and the Betaflight message set (#83). Used by `air-client-sdk` and optionally by ground for display. `core-transport` never depends on it.
- `air-client-sdk`: the passive classifier, the `FcLink` arbiter (transparent vs. control mode), the identification gate, the telemetry poller and the supervisor (#85, #86, #93). These are the only places that parse MSP on the air side; `SerialTransport` implementations and the `serial-relay` byte path stay protocol-agnostic.
  - **Implemented (#93, #85):** `LinkTypeClassifier`, `FcIdentificationGate` and `FlightControlSettingsStore` (default off), composed by `FcLink`. `air-webapp` routes every serial byte through `FcLink`, which has three modes: `passthrough` (the default and every fallback: FC chunks reach the ground exactly as read, ground chunks are written exactly as received, nothing else is written), `identifying` (setting on and 2 s without ground bytes since the link opened or the last ground byte; probe replies are consumed, and ground bytes that arrive meanwhile cancel the run and are held, at most 4 KiB, until the outstanding probe settles or 150 ms pass, then written in order), and `control` (entered only on `verified`: passthrough suspended both ways with dropped ground bytes counted, round-robin telemetry at most one request per 20 ms, and `sendRc()` writing four-channel `MSP_SET_RAW_RC` frames ahead of queued telemetry). Control mode reports `fc-link-lost` (`healthy` false) once a request has gone 500 ms without any MSP reply. This is measured from the oldest unanswered request, not the last reply, so a browser throttling a background air tab to one timer per second doesn't look like a dead FC; when replies come back, the FC may have rebooted or been swapped, so it re-identifies before control can resume. Betaflight's `MSP_STATUS_EX` carries no uptime, so this lost-and-recovered check stands in for the uptime-reset detection #85 asked for. `FlightControlController` turns all of this into `fc-state` reports (5 Hz and on change), applies `fc-setting` from the ground, and drives the air UI's *Flight control* panel.
  - **Implemented (#86):** `FlightControlSupervisor`, pure logic on an injected `Clock` with 100% branch coverage, implements §7.7 and §7.8. `FlightControlController` feeds it the gate result, link health, poller telemetry, channel state and page visibility (`visibilitychange`/`pagehide` in `air-webapp`), routes `fc-command`/`fc-control` to it, and sends its frames through `FcLink.sendRc()`. That is the second guard: `sendRc()` refuses anything unless the link is in control mode with a verified FC. Points where the issue text left a choice:
    - **Fresh handover:** every handover is the SP's MSP OVERRIDE switch seen off and then on while this supervisor watches. `RELEASED` keeps the reason it released for (so the GUI can show *Safety pilot took back control*) until such a cycle, then goes straight to `HANDED_OVER`. A switch already on when the air (re)connects, the FC link reopens or the setting is turned back on doesn't count: `IDLE` reports `awaiting-fresh-handover` (SITL drill #89, scenario 12).
    - **Air stall:** while sending, a gap of more than 300 ms since the last frame (the air page itself was frozen or throttled) means Betaflight's stale override has already handed the sticks back to the SP. The next command, tick or watchdog then releases with `air-stalled` instead of resuming, and `FcLink` drops any `MSP_SET_RAW_RC` frame that waited more than 100 ms behind a stuck write rather than writing it late (SITL drill #89, scenario 5).
    - **Heartbeat deadlines:** a one-shot timer fires at exactly the last command + 250 ms (NEUTRAL) or + 1 s (RELEASED), instead of waiting for the next 20 Hz tick, which had added up to 50 ms (drill margins, #89).
    - **Unlock after ABORT:** `unlock` is accepted in `ABORTED` as well as `HANDED_OVER`, resuming from center. The SP-sticks-neutral check only applies in `HANDED_OVER`, since `MSP_RC` reports overridden values once frames flow.
    - **Override-mask check (§7.5 step 8):** after unlock, `MSP_RC` must match a recently sent frame on all four sticks (±2 µs) within 1 s. Otherwise the supervisor releases with `override-mask-mismatch`, and `FcLink.forceTransparent()` keeps the link transparent until it is reopened or the setting is toggled.
    - **Staleness:** a status reply older than 500 ms counts as lost telemetry (`telemetry-stale`).
    - **IDLE reason:** while `IDLE`, the reason is the first precondition blocking a handover (e.g. `page-hidden`, `sp-took-control`), so the GUI can say why.
    - **Defaults:** unlock tolerances are ±25 µs on roll/pitch/yaw and ±50 µs on throttle around the hover throttle, and the minimum is 8 GPS satellites. All are `SupervisorConfig` defaults, to be tuned in the SITL drills (#89).
- `ground-client-sdk`: relays the `flight-control` channel without parsing. Only the active viewer's own socket closing ends its session, so a stray tab can't cut off the operator (#89, scenario 13). `patches/werift+0.24.4.patch` (applied by patch-package on install, guarded by `werift-patch.test.ts`) fixes werift's partial reliability (unpatched, `maxRetransmits: 0` meant reliable, so lost `fc-command`s were retransmitted with backoff and the ground->air direction stalled under loss) and its ICE consent freshness (unpatched, a slow, lossy link lost consent after 30 s and werift stopped sending to the air for good) (#89, scenarios 3 and 4).
- Ground GUI: the unlock/abort/dead-man/command-generation logic lives in a package (`ui-kit-ground` or SDK-level), not in the app (#87, #88).
  - **Implemented (#87, #88):** `ui-kit-ground`'s `FlightControlGui` (DOM-free, fake-timer unit tests) holds all of it:
    - **View model:** link type and mode with readable reasons, FC identity, the handover banner, a go/no-go checklist mirroring the supervisor's preconditions plus the 400 ms RTT gate, telemetry, and STALE after 1 s without `fc-state`.
    - **Unlock:** the 1.5 s hold, offered only when the air reports `HANDED_OVER` (or `ABORTED`) with go/no-go green. Mouse, touch or a held Enter all work; OS key repeat is ignored.
    - **Command stream:** `fc-command` at 20 Hz from the moment an unlock is sent, with zeros when idle and zeros while `ABORTED`.
    - **Re-sent until confirmed:** `abort` on every tick until the air reports `ABORTED`; `release`, `unlock` and `fc-setting` until `fc-state` reflects them. Each is dropped after 3 s.
    - **Dead-man:** window blur, hidden tab, WebSocket loss, flight-control channel closed, RTT above 400 ms (from the air's `air-status` RTT) or stale state each stop the stream and release every held key or pad.
    - **Command age:** the GUI remembers when it sent each `seq`; the age is from sending the `lastAppliedSeq` an `fc-state` reports to receiving that report, so it includes up to one report interval. Above 600 ms while `ACTIVE`, or above the air's 1 s release timeout while `NEUTRAL` (a brief gap can still resume), the dead-man stops the stream (`commands-late`), latched until the air releases: the WebRTC RTT the 400 ms gate relies on goes stale when packets are delayed by seconds (#89, scenario 4).
  - **Delivery:** `ground-web-client/src/flight-control.ts` is the DOM layer (panel, pads, sliders, keyboard, the take-control ring, and an ABORT bar pinned to the viewport while the PP holds control). `ground-core-node` bundles it with esbuild at startup and serves it as `/flight-control.js`, which the existing `gui-client.js` imports dynamically. Gamepad support (optional in #88) is not implemented yet.

## 8. Validation checklist

- `@dronelink/ground-core-node` starts standalone and resolves TLS material through `core-transport`.
- Existing pairing QR/token flow stays unchanged.
- The relay path remains protocol-agnostic.
- `TLS_PROVIDER=tailscale` still flows through `ensureTailscaleTlsMaterial()` at startup.
- Cert/key files remain ignored.
