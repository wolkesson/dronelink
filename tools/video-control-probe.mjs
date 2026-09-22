// Attaches to the ground GUI signaling socket like the browser GUI does, optionally
// sends one video-control-request, and logs every video-control-state received.
//   node tools/video-control-probe.mjs <host[:port]> [--send '<json control body>'] [--duration ms]
import { createRequire } from "node:module";
const WebSocket = createRequire(import.meta.url)("ws");

const args = process.argv.slice(2);
const host = args.find((a) => !a.startsWith("--")) ?? "localhost:8443";
const opt = (name) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const sendBody = opt("--send");
const durationMs = Number(opt("--duration") ?? 6000);

const url = `wss://${host.includes(":") ? host : `${host}:8443`}/gui-signaling`;
const ws = new WebSocket(url, { rejectUnauthorized: false });

ws.on("open", () => {
  console.error(`connected to ${url}`);
  ws.send(JSON.stringify({ type: "offer", sdp: "v=0\r\n" }));
  if (sendBody) {
    const body = JSON.parse(sendBody);
    console.error(`sending: ${JSON.stringify({ type: "video-control-request", ...body })}`);
    ws.send(JSON.stringify({ type: "video-control-request", ...body }));
  }
});
ws.on("error", (e) => console.error(`socket error: ${e.message}`));
ws.on("message", (raw) => {
  const m = JSON.parse(String(raw));
  if (m.type === "video-control-state" || m.type === "error") {
    console.log(`${new Date().toISOString()} ${JSON.stringify(m)}`);
  }
});

setTimeout(() => {
  ws.close();
  process.exit(0);
}, durationMs);
