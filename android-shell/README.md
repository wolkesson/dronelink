# android-shell

**Status: Phase 2.5, Spikes 1–3 complete; Spike 4 in progress.** See [`spikes/`](./spikes/) for individual task briefs; spike 5 is not started (see [`spikes/README.md`](./spikes/README.md)).

This component begins in **Phase 2.5** of the development plan (see [`ARCHITECTURE.md`](../ARCHITECTURE.md#6-current-implementation-state)).

## Planned scope

A thin Kotlin/Android wrapper — no business logic lives here. The full air-side logic is in [`apps/air-webapp`](../apps/air-webapp).

Responsibilities:
- **Foreground service** — keeps the process alive during flight so the OS cannot kill it.
- **USB host permission + serial bridge** — requests the Android USB host permission, owns the serial connection to the flight controller, and exposes it to the WebView as a `SerialTransport` over a `WebMessageChannel`. The PWA's `NativeBridgeTransport` is the receiving end.
- **Camera/mic permission passthrough** — requests `CAMERA` and `RECORD_AUDIO` runtime permissions, then grants them through `WebChromeClient.onPermissionRequest` so the PWA's `getUserMedia` call succeeds without native capture code.
- **Wake lock** — prevents CPU/screen sleep mid-flight.
- **Autostart** — launches the foreground service on `BOOT_COMPLETED` and `ACTION_USB_DEVICE_ATTACHED`.
- **Localhost PWA host** — serves the bundled `apps/air-webapp` build over `http://localhost:<port>` (via a small embedded HTTP server) inside a WebView. `file://` is intentionally avoided because `getUserMedia`/WebRTC require a secure context.

## What not to add

- No camera or microphone capture code (the browser engine inside WebView does this via standard web APIs).
- No telemetry parsing, flight-control logic, or UI beyond the WebView container.

## Spikes

This scope is broken into five independently implementable spikes — see [`spikes/README.md`](./spikes/README.md) for the breakdown, sequencing, and emulator-vs-real-device notes per spike.

## Building

Prerequisites: [Android Studio](https://developer.android.com/studio) (or the command-line SDK tools) with an SDK platform matching `compileSdk`/`targetSdk` (currently 34) installed, and Node.js 22+/npm for the PWA build. `android-shell` is a standalone Gradle project (its own `settings.gradle.kts`), separate from the root npm workspace.

1. Build the PWA bundle this shell embeds:
   ```sh
   npm run build --workspace @dronelink/air-webapp
   ```
   This produces `apps/air-webapp/dist/`, which the Android build copies into `android-shell/app/src/main/assets/webapp/` automatically (the `copyWebapp` Gradle task, wired into `preBuild`). Re-run this whenever the PWA changes — the Android build does not rebuild it for you.
2. Open `android-shell/` as a project in Android Studio and let it sync, **or** build from the command line:
   ```sh
   cd android-shell
   ./gradlew assembleDebug
   ```

If a build environment can't reach `dl.google.com` (Google's Maven repo, required for the Android Gradle Plugin and AndroidX libraries), Gradle will fail to resolve plugins/dependencies — this is a network policy issue in that environment, not a project problem. A normal developer machine with Android Studio installed does not hit this.

## Testing on a real device

Whether an emulator is enough depends on what you're testing — see [`spikes/README.md`](./spikes/README.md#emulator-vs-real-device) for the breakdown. Camera/mic (Spike 2) mostly works on an emulator; foreground service survival (Spike 3) needs a real device to mean anything, since it's OEM battery-management behavior that emulators don't reproduce; USB serial (Spike 4) has no emulator path at all. Steps below assume a real phone:

1. **Enable Developer Options and USB debugging on the phone**: Settings → About phone → tap "Build number" 7 times → back out to Settings → Developer options → enable "USB debugging".
2. **Connect the phone to the machine running Android Studio/adb via USB.** Accept the "Allow USB debugging?" prompt that appears on the phone (check "Always allow from this computer" to avoid repeating it).
3. **Confirm the device is visible:**
   ```sh
   adb devices
   ```
   It should list the phone as `device` (not `unauthorized` — if it says that, re-check the on-phone prompt).
4. **Install and launch:**
   - From Android Studio: select the phone in the device dropdown and click Run, or
   - From the command line:
     ```sh
     cd android-shell
     ./gradlew installDebug
     adb shell am start -n link.dronelink.androidshell/.MainActivity
     ```
5. **Verify:** the app should launch full-screen and render the `air-webapp` UI (the same UI you'd see at `https://localhost:5173` in desktop Chrome). If it doesn't load, check `adb logcat` for `MainActivity`/`LocalWebAppServer` errors — the most likely cause is step 1's PWA build being missing or stale.
6. **Debug the WebView's contents from desktop Chrome:** with the phone still connected, open `chrome://inspect#devices` in desktop Chrome. The WebView shows up as an inspectable target (debug builds call `WebView.setWebContentsDebuggingEnabled(true)`) — click "inspect" to get DevTools against the running page, same as debugging the desktop PWA.
7. **Uninstall when done testing:**
   ```sh
   adb uninstall link.dronelink.androidshell
   ```

No flight controller is required for any of this yet (that's Spike 4) — steps 1–7 only need the phone itself and a USB cable to the dev machine.

### Testing Spike 3: foreground service survival & autostart

1. **Verify the notification appears.** After installing and launching (steps 1–5 above), pull down the notification shade and confirm "DroneLink air shell running" is present. If it's missing, check whether the app was granted notification permission (Settings → Apps → DroneLink Air Shell → Notifications) — the service still runs either way, but Android 13+ hides the notification without that permission.
2. **Confirm the service and wake lock are actually held:**
   ```sh
   adb shell dumpsys activity services link.dronelink.androidshell
   adb shell dumpsys power | grep -A2 flight
   ```
   The first should show `AirShellForegroundService` running in the foreground; the second should show a held `PARTIAL_WAKE_LOCK` tagged `...:flight`.
3. **Disable battery optimization for the app before testing survival** — this is the OEM-specific step most likely to matter (see [`spikes/README.md`](./spikes/README.md#emulator-vs-real-device)). On stock Android: Settings → Apps → DroneLink Air Shell → Battery → set to "Unrestricted". On Xiaomi/MIUI, Samsung, OnePlus, etc. there's usually also a separate "Autostart"/"Auto-launch" toggle and a manufacturer battery-saver exception list — enable/allow both. Skipping this step is the most common reason a foreground service still gets killed despite doing everything else right.
4. **Idle survival:** background the app (Home button), let the screen sleep, and leave the phone alone for an extended period (15–30+ minutes is a reasonable spike check). Re-run the `dumpsys` commands from step 2 — the service should still be there.
5. **Reboot autostart:** reboot the phone (`adb reboot`, or manually) and, once it's unlocked, check the notification shade *without* opening the app. Its presence confirms `BOOT_COMPLETED` fired and started the service unattended.
6. **USB-attach autostart:** this needs an actual USB-OTG peripheral, not the debugging cable — the adb connection uses accessory/host roles differently and won't reliably fire `ACTION_USB_DEVICE_ATTACHED` the same way. Force-stop the app first (`adb shell am force-stop link.dronelink.androidshell`), then physically attach a USB-OTG device (any generic one for this spike; Spike 4 introduces the real flight controller), and confirm the notification appears without manually launching the app.
7. **Recreate real memory pressure (optional but closer to real conditions):** open several other apps to force the OS to look for kill candidates, or use `adb shell am kill link.dronelink.androidshell` (note: this only works if the process isn't already foreground-protected, so it's a useful negative check — it should generally *not* succeed while the foreground service is running).

### Testing Spike 4: USB serial bridge

This spike adds `androidx.webkit:webkit:1.11.0` and `com.github.mik3y:usb-serial-for-android:3.4.3` (JitPack) — both resolve and build cleanly in CI.

1. **Attach a USB-serial device before launching the app** — either a bench USB-to-serial adapter (FTDI/CP2102/CH340/etc.) for initial wiring checks, or the real flight controller, connected via a USB-OTG adapter/cable to the phone. This spike's controller only looks for an already-attached device when the WebView finishes loading; it doesn't retry if one shows up later (see `NativeSerialBridgeController.start()`'s doc comment).
2. **Confirm the USB permission dialog appears** the first time a given device is attached, and grant it. Subsequent launches with the same already-permitted device should skip straight to opening it. **If no dialog appears at all**, the device most likely isn't in `usb-serial-for-android`'s hardcoded VID/PID whitelist — `UsbSerialBridge.findDriver()` falls back to forcing a CDC-ACM driver for any attached device whose interface descriptors look like CDC-ACM (which covers most flight controllers, since their MCU's USB peripheral typically presents a generic CDC-ACM virtual COM port under a custom VID/PID the whitelist doesn't know about), so this should be rare — but if it still doesn't show a dialog, check the logcat tags in the next step for "No recognized USB-serial device attached."
3. **Watch logcat for the bridge's own tags:**
   ```sh
   adb logcat -s UsbSerialBridge:* NativeSerialBridge:*
   ```
   Look for `USB read error` / `USB permission denied` / `Failed to configure USB-serial port` messages if something's wrong, or silence (no errors) once connected.
4. **Verify bytes actually flow**, using the existing PWA UI rather than a separate test harness: pair with a ground station (`npm start --workspace @dronelink/ground-core-node` on a PC on the same network/Tailscale), click **Connect FC** in the Android app, and confirm the flight controller panel shows a connection and non-zero TX/RX rates — then connect INAV Configurator to the ground runtime's TCP bridge port and confirm it can actually talk to the FC, the same end-to-end check used for Phase 1.
5. **Confirm the transport selection actually took the native path**, not silently falling back to attempting `WebSerialTransport` (which would just fail, since `navigator.serial` doesn't exist in WebView): open `chrome://inspect#devices` (see the Spike 1 steps above) and check the console for `NativeBridgeTransport`-related activity, or add a temporary `console.log(navigator.userAgent)` — it should contain `DroneLinkAndroidShell`.
6. **Disconnect/error handling:** physically unplug the USB device mid-session and confirm the FC panel reflects a disconnect (mirrors `WebSerialTransport`'s zero-length-chunk disconnect signal — see `UsbSerialBridge.Listener.onError`).

**Known limitation:** the USB connection is owned by `MainActivity`, not `AirShellForegroundService` — killing/backgrounding the Activity (as opposed to the whole process) can tear down the WebView along with it. Moving USB ownership fully into the foreground service's lifecycle, so it survives independently of the Activity, is called out as a Spike 5 integration concern in the task brief rather than solved here.
