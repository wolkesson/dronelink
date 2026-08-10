# android-shell

**Status: Phase 2.5, Spike 1 complete; Spike 2 in progress.** See [`spikes/spike-1-webview-shell.md`](./spikes/spike-1-webview-shell.md) and [`spikes/spike-2-camera-mic-passthrough.md`](./spikes/spike-2-camera-mic-passthrough.md); spikes 3–5 are not started (see [`spikes/README.md`](./spikes/README.md)).

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

An Android emulator is enough for this spike (no USB/camera hardware access is needed yet — see [`spikes/README.md`](./spikes/README.md#emulator-vs-real-device) for which later spikes require real hardware). To test on a real phone instead:

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

No flight controller, camera, or USB-OTG accessory is required for this spike — it only needs the phone itself and a USB cable to the dev machine for install/debugging.
