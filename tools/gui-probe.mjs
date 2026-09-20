#!/usr/bin/env node
// Attaches to the ground GUI signaling socket like the browser GUI does and
// checks what a viewer would see. Exits 0 on success, 1 on failure.
//   node tools/gui-probe.mjs <host[:port]> [--select <index>] [--timeout <ms>]
// Without --select: asserts a camera-source-list arrives.
// With --select: also requests that camera and asserts an ok ack and an SDP answer.
import { createRequire } from "node:module";
const WebSocket = createRequire(import.meta.url)("ws");

const args = process.argv.slice(2);
const target = args.find((a) => !a.startsWith("--") && !/^\d+$/.test(a)) ?? "localhost:8443";
const opt = (name) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const select = opt("--select") === undefined ? null : Number(opt("--select"));
const timeoutMs = Number(opt("--timeout") ?? 20000);

const url = `wss://${target.includes(":") ? target : `${target}:8443`}/gui-signaling`;
const ws = new WebSocket(url, { rejectUnauthorized: process.env.INSECURE_TLS !== "1" });
const seen = { list: null, ack: null, answer: false, error: null };

const fail = (msg) => {
  console.error(`FAIL ${msg}`);
  process.exit(1);
};
const done = () => {
  if (!seen.list) return;
  if (select === null || (seen.ack?.ok && seen.answer)) {
    console.log(`OK   camera list: ${seen.list.devices.map((d) => d.label).join(", ") || "(empty)"}`);
    if (select !== null) console.log(`OK   camera ${select} acked ok and video answered`);
    process.exit(0);
  }
};

ws.on("open", () => ws.send(JSON.stringify({ type: "offer", sdp: "v=0\r\n" })));
ws.on("error", (e) => fail(`socket: ${e.message}`));
ws.on("message", (raw) => {
  const m = JSON.parse(String(raw));
  if (m.type === "error") seen.error = m.message;
  if (m.type === "answer") seen.answer = true;
  if (m.type === "video-control-state" && m.control === "camera-source-list") {
    seen.list = m;
    if (select !== null && !globalThis.requested) {
      globalThis.requested = true;
      const device = m.devices[select];
      if (!device) fail(`no camera at index ${select}`);
      ws.send(JSON.stringify({ type: "video-control-request", control: "camera-source", deviceId: device.deviceId }));
    }
  }
  if (m.type === "video-control-state" && m.control === "camera-source") {
    seen.ack = m;
    if (!m.ok) fail(`camera switch failed: ${m.error}`);
  }
  done();
});
setTimeout(
  () => fail(`timed out after ${timeoutMs}ms (${JSON.stringify({ list: Boolean(seen.list), ack: seen.ack?.ok, answer: seen.answer, error: seen.error })})`),
  timeoutMs,
);
