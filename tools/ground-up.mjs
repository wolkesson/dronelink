#!/usr/bin/env node
// Starts ground-core-node over Tailscale (replacing any process already on the
// port), waits for it to print its pairing bundle, prints just that bundle, and
// leaves the process running.
//   node tools/ground-up.mjs [--lan <ip>]     # default: this PC's Tailscale MagicDNS name
import { spawn, spawnSync } from "node:child_process";
import { openSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { sh } from "./lib.mjs";

const PORT = 8443;
const lanIdx = process.argv.indexOf("--lan");
const env = { ...process.env };

if (lanIdx > 0) {
  env.SIGNAL_HOST = env.SIGNAL_TLS_TARGET = process.argv[lanIdx + 1];
} else {
  const status = sh("tailscale", ["status", "--json"]);
  if (!status.ok) throw new Error(`tailscale status failed: ${status.err}`);
  const name = JSON.parse(status.out).Self.DNSName.replace(/\.$/, "");
  env.SIGNAL_HOST = env.SIGNAL_TLS_TARGET = name;
  env.TLS_PROVIDER = "tailscale";
}

if (process.platform === "win32") {
  const owner = sh("powershell", [
    "-NoProfile",
    "-Command",
    `(Get-NetTCPConnection -LocalPort ${PORT} -State Listen -ErrorAction SilentlyContinue).OwningProcess`,
  ]).out;
  if (owner) {
    console.error(`Stopping previous ground process (pid ${owner})`);
    spawnSync("taskkill", ["/PID", owner.split(/\s+/)[0], "/T", "/F"]);
  }
}

const logPath = join(tmpdir(), "dronelink-ground.log");
const fd = openSync(logPath, "w");
const groundDir = fileURLToPath(new URL("../apps/ground-core-node", import.meta.url));
const tsxCli = fileURLToPath(new URL("../node_modules/tsx/dist/cli.mjs", import.meta.url));
const child = spawn(process.execPath, [tsxCli, "src/index.ts"], {
  cwd: groundDir,
  env,
  stdio: ["ignore", fd, fd],
  detached: true,
  windowsHide: true,
});
child.on("error", (err) => {
  console.error(`Failed to start ground: ${err.message}`);
  process.exit(1);
});
child.unref();

for (let i = 0; i < 60; i++) {
  await new Promise((r) => setTimeout(r, 500));
  const log = readFileSync(logPath, "utf8");
  const m = /Pairing bundle JSON:\s*(\{[\s\S]*?\})/.exec(log);
  if (m) {
    console.log(JSON.stringify(JSON.parse(m[1])));
    console.error(`Ground log: ${logPath}`);
    process.exit(0);
  }
}
console.error(`Ground did not print a pairing bundle in 30s; see ${logPath}`);
process.exit(1);
