import { spawnSync } from "node:child_process";

export function sh(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, { encoding: "utf8", shell: false, ...opts });
  return { ok: r.status === 0, out: (r.stdout ?? "").trim(), err: (r.stderr ?? "").trim() };
}

export function adb(...args) {
  return sh("adb", args);
}

export const APP_ID = "link.dronelink.androidshell";
