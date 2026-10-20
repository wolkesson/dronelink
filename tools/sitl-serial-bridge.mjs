#!/usr/bin/env node
// Dev-only WebSocket <-> TCP bridge so the air webapp (WebSocketSerialTransport) can reach a
// Betaflight SITL UART, which SITL exposes as a TCP socket (UART1 = 5761). Bytes are relayed
// opaquely in both directions; one WebSocket client at a time, each with its own TCP
// connection. Listens on 127.0.0.1 only: Chrome allows ws:// to localhost from the https
// air-webapp page, and nothing else should reach a flight controller this way.
//   node tools/sitl-serial-bridge.mjs [--listen 5770] [--target 127.0.0.1:5761]
import { createConnection } from "node:net";
import { WebSocketServer } from "ws";

function arg(name, fallback) {
  const i = process.argv.indexOf(name);
  return i > 0 ? process.argv[i + 1] : fallback;
}

const listenPort = Number(arg("--listen", "5770"));
const [targetHost, targetPortText] = arg("--target", "127.0.0.1:5761").split(":");
const targetPort = Number(targetPortText);

const wss = new WebSocketServer({ host: "127.0.0.1", port: listenPort });
let active = null;

wss.on("listening", () => {
  console.log(`sitl-serial-bridge: ws://127.0.0.1:${listenPort} <-> tcp://${targetHost}:${targetPort}`);
});

wss.on("connection", (ws) => {
  if (active) {
    console.log("sitl-serial-bridge: refusing a second client");
    ws.close(1013, "bridge busy");
    return;
  }
  active = ws;
  const tcp = createConnection({ host: targetHost, port: targetPort });
  tcp.setNoDelay(true);
  let toFc = 0;
  let fromFc = 0;

  const teardown = (reason) => {
    if (active !== ws) return;
    active = null;
    console.log(`sitl-serial-bridge: closed (${reason}); ${toFc} B to FC, ${fromFc} B from FC`);
    tcp.destroy();
    ws.close();
  };

  tcp.on("connect", () => console.log("sitl-serial-bridge: client connected to SITL"));
  tcp.on("data", (chunk) => {
    fromFc += chunk.length;
    ws.send(chunk, { binary: true });
  });
  tcp.on("error", (err) => teardown(`tcp error: ${err.message}`));
  tcp.on("close", () => teardown("tcp closed"));

  ws.on("message", (data, isBinary) => {
    if (!isBinary) return;
    toFc += data.length;
    tcp.write(data);
  });
  ws.on("close", () => teardown("client closed"));
  ws.on("error", (err) => teardown(`ws error: ${err.message}`));
});
