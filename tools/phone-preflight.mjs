#!/usr/bin/env node
// Checks the remote-dev prerequisites for a phone attached over adb, and fixes
// the ones that are safe to fix (screen wake, Wi-Fi). Exits non-zero on any failure.
//   node tools/phone-preflight.mjs [--ping <tailscale-ip-or-name>]
import { adb, sh, APP_ID } from "./lib.mjs";

const pingIdx = process.argv.indexOf("--ping");
const pingTarget = pingIdx > 0 ? process.argv[pingIdx + 1] : null;
let failed = false;

function report(name, ok, detail = "") {
  if (!ok) failed = true;
  console.log(`${ok ? "OK  " : "FAIL"} ${name}${detail ? ` - ${detail}` : ""}`);
}

const devices = adb("devices").out.split("\n").slice(1).filter(Boolean);
const ready = devices.filter((l) => /\tdevice$/.test(l));
report("adb device", ready.length === 1, ready.length === 0 ? devices.join("; ") || "none attached" : ready[0].split("\t")[0]);
if (ready.length !== 1) process.exit(1);

adb("shell", "input keyevent KEYCODE_WAKEUP");
const locked = /mDreamingLockscreen=true|isKeyguardShowing=true/.test(adb("shell", "dumpsys window").out);
report("screen unlocked", !locked, locked ? "locked - only the user can unlock it" : "");

if (!/Wi-Fi is enabled/.test(adb("shell", "dumpsys wifi").out)) {
  adb("shell", "svc wifi enable");
  await new Promise((r) => setTimeout(r, 6000));
}
const wlan = /inet (\S+)/.exec(adb("shell", "ip -4 addr show wlan0").out);
report("wifi", Boolean(wlan), wlan?.[1] ?? "no address on wlan0");

const installed = adb("shell", `dumpsys package ${APP_ID}`).out;
const updated = /lastUpdateTime=(.+)/.exec(installed)?.[1];
report("app installed", Boolean(updated), updated ? `last updated ${updated}` : `${APP_ID} not found`);

if (pingTarget) {
  const r = sh("tailscale", ["ping", "-c", "2", "--timeout", "5s", pingTarget]);
  report("tailscale reachability from PC", r.ok, r.ok ? r.out.split("\n").pop() : r.out || r.err);
}

process.exit(failed ? 1 : 0);
