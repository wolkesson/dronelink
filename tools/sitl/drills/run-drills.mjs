#!/usr/bin/env node
// SITL failure drills for flight control over the mobile link (#89). Runs the real chain:
//
//   Betaflight SITL (drill_sim.py: physics, virtual GPS, scripted safety pilot, 50 Hz sampler)
//     ─tcp 5761─ capture proxy (this process, tcp 5765: records every byte both ways)
//     ─ tools/sitl-serial-bridge.mjs (ws 5770) ─ air-webapp (Vite dev, headless Chromium)
//     ─WebRTC─ ground-core-node (tcp bridge 5771) ─ ground GUI /gui (headless Chromium, keyboard)
//
// and for each scenario of #89 hands over, unlocks, holds forward + yaw + climb in the GUI,
// injects the fault and asserts on what the FC actually did (MSP_RC sampled over UART2),
// what the air reported (fc-state transitions), drift (sim ground truth) and bytes on the wire.
//
//   sudo node tools/sitl/drills/run-drills.mjs --bf-dir ~/betaflight \
//       [--runs 10] [--only 1,7,16] [--out docs/sim/drills]
//
// Needs: a built SITL (docs/sim/betaflight-sitl.md), Playwright + Chromium (npm i -g playwright;
// npx playwright install chromium), mkcert for ground-core-node's TLS, and root for the network
// scenarios 3 and 4 (iptables; scenario 4 also NetfilterQueue, see netimpair.py). Scenarios
// that can't run in an environment are reported as skipped with the reason, never as passed.
import { spawn, execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { createConnection, createServer } from "node:net";
import { request as httpsRequest } from "node:https";
import { mkdirSync, writeFileSync, createWriteStream } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as sleep } from "node:timers/promises";

const require = createRequire(import.meta.url);
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const HERE = dirname(fileURLToPath(import.meta.url));

// --- options ------------------------------------------------------------------------------

const argv = process.argv.slice(2);
const opt = (name, fallback) => {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : fallback;
};
const BF_DIR = opt("--bf-dir");
if (!BF_DIR) {
  console.error("usage: node tools/sitl/drills/run-drills.mjs --bf-dir <betaflight checkout> [--runs N] [--only 1,7] [--out dir]");
  process.exit(2);
}
const RUNS = Number(opt("--runs", "1"));
const ONLY = opt("--only")?.split(",").map((s) => s.trim());
const OUT = resolve(opt("--out", join(ROOT, "docs/sim/drills")));
const WORK = resolve(opt("--workdir", join(ROOT, "sitl-drills")));
const HEADED = argv.includes("--headed");

let chromium;
try {
  ({ chromium } = require("playwright"));
} catch {
  try {
    ({ chromium } = require(execFileSync("npm", ["root", "-g"]).toString().trim() + "/playwright"));
  } catch {
    console.error("Playwright not found: npm i -g playwright && npx playwright install chromium");
    process.exit(2);
  }
}
const WebSocket = require(require.resolve("ws", { paths: [join(ROOT, "packages/ground-client-sdk")] }));

// --- constants ----------------------------------------------------------------------------

const PORTS = { sitl: 5761, proxy: 5765, bridge: 5770, groundBridge: 5771, signal: 8443, air: 5173, sim: 5790 };
const HOVER = 1275;
/** Rest positions of the SP's sticks: inside the hold deadbands, but distinct from the air's neutral. */
const SP = { roll: 1512, pitch: 1488, yaw: 1508, throttle: 1285 };
const SP_STICKS = [SP.roll, SP.pitch, SP.yaw, SP.throttle];
const CENTER = [1500, 1500, 1500, HOVER];
const BOX = { ARM: 0, ALTHOLD: 3, POSHOLD: 11, FAILSAFE: 27, OVERRIDE: 50 };
/** Pass criteria (also in docs/sim/flight-control-drills.md). */
const LIMITS = {
  neutralMs: 300, // air centers the sticks after a lost heartbeat / ABORT
  releaseMs: 1200, // air RELEASED after a lost heartbeat
  fcFallbackMs: 400, // FC back on the SP's sticks after the last frame (300 ms stale + RX feed + sampling)
  spTakebackMs: 150, // FC on the SP's sticks after the switch flips back (next RX frame)
  settleMs: 4000, // drift is measured from fault + settle ...
  windowMs: 4000, // ... over this window
  driftH: 2.0, // m
  driftZ: 1.0, // m
  driftHeading: 10, // deg
};
const SESSION = { sessionId: "drills", token: "ZHJpbGxzLWRyb25lbGluaw" };

// --- process helpers ----------------------------------------------------------------------

mkdirSync(WORK, { recursive: true });
mkdirSync(OUT, { recursive: true });
const children = new Set();

function start(name, cmd, args, { env = {}, ready, cwd = ROOT } = {}) {
  const log = createWriteStream(join(WORK, `${name}.log`), { flags: "a" });
  const proc = spawn(cmd, args, { cwd, env: { ...process.env, ...env }, stdio: ["ignore", "pipe", "pipe"], detached: true });
  children.add(proc);
  proc.on("exit", () => children.delete(proc));
  let buffer = "";
  const readyPromise = new Promise((resolveReady, reject) => {
    const onData = (chunk) => {
      log.write(chunk);
      buffer += chunk.toString();
      if (ready && ready.test(buffer)) resolveReady();
    };
    proc.stdout.on("data", onData);
    proc.stderr.on("data", onData);
    proc.on("exit", (code) => reject(new Error(`${name} exited (${code}) before it was ready; see ${WORK}/${name}.log`)));
    if (!ready) resolveReady();
  });
  return { proc, name, ready: Promise.race([readyPromise, sleep(90_000).then(() => { throw new Error(`${name} not ready after 90 s`); })]) };
}

function kill(p, signal = "SIGKILL") {
  if (!p || p.proc.exitCode !== null) return;
  try {
    process.kill(-p.proc.pid, signal);
  } catch {
    p.proc.kill(signal);
  }
}

function alive(p) {
  return p && p.proc.exitCode === null && p.proc.signalCode === null;
}

async function waitFor(what, predicate, timeoutMs = 10_000, intervalMs = 50) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await predicate();
    if (value) return value;
    if (Date.now() > deadline) {
      const air = chain.air && !chain.air.isClosed() ? await airNow().catch(() => null) : null;
      throw new Error(`timed out waiting for ${what}${air ? ` (air: ${air.sup} ${air.reason ?? ""}, link ${air.mode} ${air.linkReason ?? ""})` : ""}`);
    }
    await sleep(intervalMs);
  }
}

function httpsJson(path) {
  return new Promise((resolveJson, reject) => {
    const req = httpsRequest({ host: "localhost", port: PORTS.signal, path, rejectUnauthorized: false }, (res) => {
      let body = "";
      res.on("data", (c) => (body += c));
      res.on("end", () => {
        try {
          resolveJson(JSON.parse(body));
        } catch (e) {
          reject(e);
        }
      });
    });
    req.on("error", reject);
    req.end();
  });
}

// --- the simulator (drill_sim.py) ---------------------------------------------------------

class Sim {
  constructor() {
    this.queue = [];
    this.buffer = "";
  }

  async connect() {
    this.sock = createConnection({ port: PORTS.sim, host: "127.0.0.1" });
    await new Promise((r, j) => (this.sock.once("connect", r), this.sock.once("error", j)));
    this.sock.on("data", (d) => {
      this.buffer += d.toString();
      let nl;
      while ((nl = this.buffer.indexOf("\n")) >= 0) {
        const line = this.buffer.slice(0, nl);
        this.buffer = this.buffer.slice(nl + 1);
        this.queue.shift()?.(JSON.parse(line));
      }
    });
  }

  call(cmd, args = {}) {
    return new Promise((r) => {
      this.queue.push(r);
      this.sock.write(JSON.stringify({ cmd, ...args }) + "\n");
    });
  }

  state() {
    return this.call("state");
  }

  pilot(values) {
    return this.call("pilot", values);
  }

  async samples(since) {
    return (await this.call("samples", { since })).samples;
  }
}

// --- capture proxy between the serial bridge and the FC -----------------------------------

class CaptureProxy {
  constructor() {
    this.chunks = []; // { t, dir: "toFc" | "fromFc", bytes: Buffer }
    this.upstream = { kind: "sitl" };
    this.sockets = new Set();
  }

  listen() {
    this.server = createServer((client) => {
      this.sockets.add(client);
      client.setNoDelay(true);
      const record = (dir, bytes) => this.chunks.push({ t: Date.now(), dir, bytes: Buffer.from(bytes) });
      if (this.upstream.kind === "fake") {
        const fake = this.upstream.make();
        client.on("data", (d) => {
          record("toFc", d);
          fake.onData(d);
        });
        fake.start((d) => {
          record("fromFc", d);
          if (!client.destroyed) client.write(d);
        });
        client.on("close", () => {
          fake.stop();
          this.sockets.delete(client);
        });
        client.on("error", () => undefined);
        return;
      }
      const fc = createConnection({ host: "127.0.0.1", port: PORTS.sitl });
      fc.setNoDelay(true);
      this.sockets.add(fc);
      client.on("data", (d) => {
        record("toFc", d);
        fc.write(d);
      });
      fc.on("data", (d) => {
        record("fromFc", d);
        client.write(d);
      });
      const close = () => {
        client.destroy();
        fc.destroy();
        this.sockets.delete(client);
        this.sockets.delete(fc);
      };
      client.on("close", close);
      fc.on("close", close);
      client.on("error", close);
      fc.on("error", close);
    });
    return new Promise((r) => this.server.listen(PORTS.proxy, "127.0.0.1", r));
  }

  /** Drops every open connection (the bridge then closes the air's WebSocket). */
  dropAll() {
    for (const s of this.sockets) s.destroy();
    this.sockets.clear();
  }

  bytes(dir, from, to = Infinity) {
    return Buffer.concat(this.chunks.filter((c) => c.dir === dir && c.t >= from && c.t <= to).map((c) => c.bytes));
  }
}

// --- MSP helpers (for the transparency scenarios and the capture analysis) ----------------

function mspRequest(cmd) {
  return Buffer.from([0x24, 0x4d, 0x3c, 0, cmd, cmd]);
}

function mspResponse(cmd, payload) {
  const frame = Buffer.alloc(6 + payload.length);
  frame.set([0x24, 0x4d, 0x3e, payload.length, cmd]);
  frame.set(payload, 5);
  let x = payload.length ^ cmd;
  for (const b of payload) x ^= b;
  frame[frame.length - 1] = x;
  return frame;
}

/** MSP v1 frames (cmd numbers) in a byte stream: requests ('<'), or replies ('>' and errors '!'). Handles jumbo frames. */
function mspFrames(buf, direction = 0x3c) {
  const directions = direction === 0x3c ? [0x3c] : [0x3e, 0x21];
  const out = [];
  for (let i = 0; i + 5 < buf.length; i++) {
    if (buf[i] !== 0x24 || buf[i + 1] !== 0x4d || !directions.includes(buf[i + 2])) continue;
    let size = buf[i + 3];
    let header = 5;
    if (size === 0xff) {
      if (i + 7 > buf.length) break;
      size = buf[i + 5] | (buf[i + 6] << 8);
      header = 7;
    }
    if (i + header + size + 1 > buf.length) break;
    let x = 0;
    for (let k = i + 3; k < i + header + size; k++) x ^= buf[k];
    if (x === buf[i + header + size]) {
      out.push(buf[i + 4]);
      i += header + size;
    }
  }
  return out;
}

// --- fake FCs for scenarios 14c and 17 ----------------------------------------------------

/** A scripted MSP FC that answers the identification probes with fixed replies. */
function fakeMspFc(replies) {
  let send = () => undefined;
  let buf = Buffer.alloc(0);
  return {
    start: (s) => (send = s),
    stop: () => undefined,
    onData(d) {
      buf = Buffer.concat([buf, d]);
      for (const cmd of mspFrames(buf)) send(mspResponse(cmd, replies[cmd] ?? Buffer.alloc(0)));
      buf = Buffer.alloc(0);
    },
  };
}

const fakeInav = () =>
  fakeMspFc({
    1: Buffer.from([0, 2, 5]), // MSP_API_VERSION 2.5
    2: Buffer.from("INAV"),
    3: Buffer.from([8, 0, 1]),
  });

/** Betaflight 2025.12.5 as it identifies itself (MSP API 1.47): keeps a stale override forever. */
const fakeBetaflight2025 = () =>
  fakeMspFc({
    1: Buffer.from([0, 1, 47]),
    2: Buffer.from("BTFL"),
    3: Buffer.concat([Buffer.from([25, 12, 5, 9]), Buffer.from("2025.12.5")]),
  });

function x25(bytes, crc = 0xffff) {
  for (const b of bytes) {
    let tmp = b ^ (crc & 0xff);
    tmp = (tmp ^ (tmp << 4)) & 0xff;
    crc = ((crc >> 8) ^ (tmp << 8) ^ (tmp << 3) ^ (tmp >> 4)) & 0xffff;
  }
  return crc;
}

function mavlinkV2(seq, msgid, payload, crcExtra) {
  const header = Buffer.from([0xfd, payload.length, 0, 0, seq & 0xff, 1, 1, msgid & 0xff, (msgid >> 8) & 0xff, msgid >> 16]);
  const body = Buffer.concat([header.subarray(1), payload]);
  const crc = x25([crcExtra], x25(body));
  return Buffer.concat([header, payload, Buffer.from([crc & 0xff, crc >> 8])]);
}

function fakeMavlink() {
  let timer = null;
  let seq = 0;
  return {
    start(send) {
      timer = setInterval(() => {
        // HEARTBEAT (0, crc extra 50): quadrotor, ArduPilot, armed-ish; then ATTITUDE (30, 39)
        send(mavlinkV2(seq++, 0, Buffer.from([0, 0, 0, 0, 2, 3, 0x81, 4, 3]), 50));
        send(mavlinkV2(seq++, 30, Buffer.alloc(28), 39));
      }, 100);
    },
    stop: () => clearInterval(timer),
    onData: () => undefined,
  };
}

// --- the chain ----------------------------------------------------------------------------

const chain = { sim: null, simClient: new Sim(), proxy: new CaptureProxy(), bridge: null, ground: null, airServer: null, browser: null, air: null, gui: null, impair: null };

async function startBridge() {
  chain.bridge = start("bridge", "node", ["tools/sitl-serial-bridge.mjs", "--target", `127.0.0.1:${PORTS.proxy}`], { ready: /sitl-serial-bridge: ws:/ });
  await chain.bridge.ready;
}

async function startGround() {
  chain.ground = start("ground", "npm", ["start", "--workspace", "@dronelink/ground-core-node"], {
    env: { BRIDGE_TCP_PORT: String(PORTS.groundBridge), PAIRING_SESSION_ID: SESSION.sessionId, PAIRING_TOKEN: SESSION.token },
    ready: /Signaling server listening/,
  });
  await chain.ground.ready;
}

async function setup() {
  chain.sim = start("drill-sim", "python3", [join(HERE, "drill_sim.py"), "--bf-dir", BF_DIR, "--workdir", join(WORK, "sitl")], { ready: /READY/ });
  await chain.sim.ready;
  await chain.simClient.connect();
  await chain.proxy.listen();
  await startBridge();
  await startGround();
  chain.airServer = start("air-webapp", "npm", ["run", "dev", "--workspace", "@dronelink/air-webapp", "--", "--port", String(PORTS.air), "--strictPort"], {
    env: { DRONELINK_DEV_HTTP: "1" },
    ready: /Local:/,
  });
  await chain.airServer.ready;
  chain.browser = await chromium.launch({
    headless: !HEADED,
    args: [
      "--use-fake-ui-for-media-stream",
      "--use-fake-device-for-media-stream",
      "--disable-background-timer-throttling",
      "--disable-renderer-backgrounding",
      "--disable-backgrounding-occluded-windows",
    ],
  });
}

async function teardown() {
  await chain.browser?.close().catch(() => undefined);
  if (chain.impair) kill(chain.impair, "SIGTERM");
  try {
    execFileSync("python3", [join(HERE, "netimpair.py"), "clear"], { stdio: "ignore" });
  } catch {
    /* not root: nothing was added */
  }
  await chain.simClient.call("quit").catch(() => undefined);
  await sleep(500);
  for (const c of [...children]) kill({ proc: c });
}

// --- air page -----------------------------------------------------------------------------

const AIR_HOOK = `(() => {
  const fc = window.__dronelinkFlightControl;
  if (!fc) return false;
  if (window.__fcLog) return true;
  window.__fcLog = [];
  let last = "";
  const push = (s) => {
    const e = { t: Date.now(), sup: s.supervisor.state, reason: s.supervisor.reason, mode: s.link.mode,
      linkReason: s.link.reason, detected: s.link.detectedType, enabled: s.flightControlEnabled };
    const key = JSON.stringify({ ...e, t: 0 });
    if (key !== last) { last = key; window.__fcLog.push(e); }
  };
  fc.onStateChange(push);
  push(fc.buildState());
  return true;
})()`;

async function airOpen() {
  // A reload keeps the air unit's browser storage (the flight-control setting lives there), so
  // reuse the context; only the first open, or a dead browser context, makes a new one.
  let context = chain.air && !chain.air.isClosed() ? chain.air.context() : null;
  if (chain.air && !chain.air.isClosed()) await chain.air.close().catch(() => undefined);
  context ??= chain.airContext ?? (await chain.browser.newContext({ ignoreHTTPSErrors: true, viewport: { width: 420, height: 1000 } }));
  chain.airContext = context;
  chain.air = await context.newPage();
  await chain.air.goto(`http://localhost:${PORTS.air}/?fc=ws://localhost:${PORTS.bridge}`);
  await waitFor("air flight-control hook", () => chain.air.evaluate(AIR_HOOK), 20_000);
  const bundle = await httpsJson("/gui-pairing-bundle");
  await chain.air.evaluate((text) => {
    const toggle = document.querySelector('[aria-label="Enter binding phrase"]');
    if (toggle && toggle.getAttribute("aria-pressed") !== "true") toggle.click();
    const area = document.querySelector("textarea");
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value").set.call(area, text);
    area.dispatchEvent(new Event("input", { bubbles: true }));
    document.querySelector(".dl-link__pair-button").click();
  }, JSON.stringify(bundle));
  await waitFor("air paired", () => chain.air.evaluate(() => !!document.querySelector(".dl-header__title-dot--connected")), 30_000);
  await airConnectFc();
}

async function airConnectFc() {
  await waitFor("Connect FC row", () => chain.air.evaluate(() => {
    const row = document.querySelector(".dl-fc__row");
    if (!row || row.hidden) return false;
    row.click();
    return true;
  }), 10_000);
  await waitFor("FC connected", () => chain.air.evaluate(() => document.querySelector(".dl-fc__row")?.hidden === true), 10_000);
}

const airFcConnected = () => chain.air.evaluate(() => document.querySelector(".dl-fc__row")?.hidden === true).catch(() => false);
const airPaired = () => chain.air.evaluate(() => !!document.querySelector(".dl-header__title-dot--connected")).catch(() => false);
const airLog = (since = 0) => chain.air.evaluate((s) => (window.__fcLog ?? []).filter((e) => e.t >= s), since);
const airNow = async () => (await airLog()).at(-1);

async function airSetEnabled(enabled) {
  await chain.air.evaluate((want) => {
    const box = document.querySelector(".dl-fcp__toggle input");
    if (box.checked !== want) box.click();
  }, enabled);
  await waitFor(`air setting ${enabled}`, async () => (await airNow())?.enabled === enabled, 3_000);
}

// --- ground GUI page ----------------------------------------------------------------------

const GUI_HOOK = `(() => {
  if (window.__guiLog) return true;
  if (!document.querySelector(".fcp-banner")) return false;
  window.__guiLog = [];
  let last = "";
  setInterval(() => {
    const banner = document.querySelector(".fcp-banner");
    const text = banner && !banner.hidden ? banner.textContent : "";
    const deadman = document.querySelector(".fcp-deadman");
    const key = text + "|" + (deadman && !deadman.hidden ? deadman.textContent : "");
    if (key !== last) { last = key; window.__guiLog.push({ t: Date.now(), banner: text, deadman: deadman && !deadman.hidden ? deadman.textContent : "" }); }
  }, 20);
  return true;
})()`;

async function guiOpen() {
  if (chain.gui) await chain.gui.context().close().catch(() => undefined);
  const context = await chain.browser.newContext({ ignoreHTTPSErrors: true, viewport: { width: 1000, height: 1400 } });
  chain.gui = await context.newPage();
  await chain.gui.goto(`https://localhost:${PORTS.signal}/gui`);
  await waitFor("GUI panel", () => chain.gui.evaluate(GUI_HOOK), 20_000);
  await waitFor("GUI has air state", guiFresh, 20_000);
}

const guiLog = (since = 0) => chain.gui.evaluate((s) => (window.__guiLog ?? []).filter((e) => e.t >= s), since).catch(() => []);
const guiGo = () => chain.gui.evaluate(() => document.querySelector(".fcp-go")?.textContent === "GO").catch(() => false);
const guiFresh = () =>
  chain.gui
    .evaluate(() => {
      const panel = document.querySelector(".fcp");
      const link = document.querySelectorAll(".fcp-row__value")[1]?.textContent ?? "";
      return !!panel && !panel.classList.contains("fcp--stale") && !link.startsWith("No flight-control state");
    })
    .catch(() => false);

async function guiHoldKeys(keys) {
  for (const k of keys) await chain.gui.keyboard.down(k);
}

async function guiReleaseKeys(keys) {
  for (const k of keys) await chain.gui.keyboard.up(k).catch(() => undefined);
}

async function guiUnlock() {
  await waitFor("GUI go", guiGo, 8_000);
  await chain.gui.bringToFront();
  await chain.gui.keyboard.down("Enter");
  await sleep(1_700);
  await chain.gui.keyboard.up("Enter");
  try {
    await waitFor("air ACTIVE after unlock", async () => (await airNow())?.sup === "ACTIVE", 4_000);
  } catch (error) {
    throw new Error(`${error.message}; GUI: ${JSON.stringify(await guiDiag())}`);
  }
}

/** What the GUI showed, for failure messages. */
const guiDiag = () =>
  chain.gui
    .evaluate(() => ({
      go: document.querySelector(".fcp-go")?.textContent,
      red: [...document.querySelectorAll(".fcp-go-list .fcp-bad")].map((li) => li.textContent),
      take: { hidden: document.querySelector(".fcp-take")?.hidden, disabled: document.querySelector(".fcp-take")?.disabled },
      deadman: document.querySelector(".fcp-deadman:not([hidden])")?.textContent ?? null,
      error: document.querySelector(".fcp-error:not([hidden])")?.textContent ?? null,
      focused: document.hasFocus(),
    }))
    .catch((e) => String(e));

// --- getting into a scenario's starting state ---------------------------------------------

const FLY_KEYS = ["KeyW", "KeyE", "KeyR"]; // forward + yaw right + climb

async function ensureChain() {
  if (!alive(chain.bridge)) await startBridge();
  let groundRestarted = false;
  if (!alive(chain.ground)) {
    await startGround();
    groundRestarted = true;
  }
  if (groundRestarted || !chain.air || !(await airPaired())) await airOpen();
  else if (!(await airFcConnected())) await airConnectFc();
  if (groundRestarted || !chain.gui || chain.gui.isClosed() || !(await guiFresh())) await guiOpen();
}

async function ensureAirborne() {
  const s = await chain.simClient.state();
  const flying = s.fc.modes.includes(BOX.ARM) && s.fc.modes.includes(BOX.POSHOLD) && s.truth.up > 2 && s.pilot.link;
  if (flying) return;
  await chain.simClient.pilot({ override: false, link: true, hold: false, arm: false, roll: 1500, pitch: 1500, yaw: 1500, throttle: 1000 });
  if (s.truth.up < 0.5 || !s.fc.modes.includes(BOX.ARM)) await chain.simClient.call("reset_model");
  await sleep(1_000);
  const res = await chain.simClient.call("takeoff");
  if (!res.ok) throw new Error(`take-off failed: ${res.message}`);
  await sleep(1_500);
}

/** The air has seen the SP's handover switch off (not just "IDLE", which a fresh air page starts in). */
async function waitSwitchSeenOff() {
  await waitFor("air sees the handover switch off", async () => {
    const now = await airNow();
    return now?.sup === "IDLE" && now.reason === "sp-took-control";
  }, 6_000);
}

async function establishFlying() {
  await ensureChain();
  await ensureAirborne();
  await chain.simClient.pilot({ ...SP, hold: true, angle: true });
  if (!(await airNow())?.enabled) await airSetEnabled(true);
  await waitFor("FC verified", async () => (await airNow())?.mode === "verified", 15_000);
  // A fresh handover: switch seen off, then on.
  await chain.simClient.pilot({ override: false });
  await waitSwitchSeenOff();
  await chain.simClient.pilot({ override: true });
  await waitFor("air HANDED_OVER", async () => (await airNow())?.sup === "HANDED_OVER", 6_000);
  await guiUnlock();
  await guiHoldKeys(FLY_KEYS);
  await sleep(2_000);
  const recent = await chain.simClient.samples(Date.now() - 300);
  if (!recent.some((s) => classify(s) === "pp")) throw new Error("the PP's command never reached the FC");
  return Date.now();
}

async function afterScenario() {
  if (chain.gui && !chain.gui.isClosed()) {
    await guiReleaseKeys([...FLY_KEYS, "Enter", "Space"]);
    await chain.gui.evaluate(() => window.dispatchEvent(new Event("focus"))).catch(() => undefined);
  }
  if (chain.impair) {
    kill(chain.impair, "SIGTERM");
    chain.impair = null;
    await sleep(500);
  }
  chain.proxy.upstream = { kind: "sitl" };
  await chain.simClient.pilot({ ...SP, link: true, hold: true });
}

// --- analysis -----------------------------------------------------------------------------

const near = (a, b, tol = 3) => a.every((v, i) => Math.abs(v - b[i]) <= tol);
/** What the FC's stick channels follow: the SP's TX, the air's centered neutral, or the PP. */
function classify(s) {
  const sticks = s[1].slice(0, 4);
  if (near(sticks, s[7].slice(0, 4))) return "sp";
  if (near(sticks, CENTER)) return "center";
  return "pp";
}

const firstAt = (samples, t0, kind) => samples.find((s) => s[0] >= t0 && classify(s) === kind)?.[0];
const lastAt = (samples, t0, kind) => samples.filter((s) => s[0] >= t0 && classify(s) === kind).at(-1)?.[0];

function drift(samples, t0) {
  const window = samples.filter((s) => s[0] >= t0 + LIMITS.settleMs && s[0] <= t0 + LIMITS.settleMs + LIMITS.windowMs);
  if (window.length < 20) return null;
  const [ref] = window;
  let h = 0;
  let z = 0;
  let hdg = 0;
  for (const s of window) {
    h = Math.max(h, Math.hypot(s[3] - ref[3], s[4] - ref[4]));
    z = Math.max(z, Math.abs(s[5] - ref[5]));
    hdg = Math.max(hdg, Math.abs(((s[6] - ref[6] + 540) % 360) - 180));
  }
  const atFault = samples.find((s) => s[0] >= t0);
  const end = window.at(-1);
  return {
    h: +h.toFixed(2),
    z: +z.toFixed(2),
    heading: +hdg.toFixed(1),
    travelAfterFault: atFault ? +Math.hypot(end[3] - atFault[3], end[4] - atFault[4]).toFixed(1) : null,
    climbAfterFault: atFault ? +(end[5] - atFault[5]).toFixed(2) : null,
  };
}

/** Scenario 18: AUX1-4 as the FC sees them always equal what the SP's TX sends. */
function auxMismatches(samples) {
  let lastTx = null;
  let changedAt = 0;
  let bad = 0;
  for (const s of samples) {
    const tx = s[7].slice(4, 8).join();
    if (tx !== lastTx) {
      lastTx = tx;
      changedAt = s[0];
    }
    const failsafe = s[2].includes(BOX.FAILSAFE) || !s[8];
    if (failsafe || s[0] - changedAt < 120) continue;
    if (s[1].slice(4, 8).join() !== tx) bad++;
  }
  return bad;
}

const check = (name, value, pass, limit) => ({ name, value, limit, pass: Boolean(pass) });
const rel = (t, t0) => (t === undefined || t === null ? null : Math.round(t - t0));
const firstLog = (log, t0, pred) => log.find((e) => e.t >= t0 && pred(e));

function driftChecks(d) {
  if (!d) return [check("drift measured", "no samples", false, "")];
  return [
    check("hold: horizontal drift (m)", d.h, d.h <= LIMITS.driftH, `≤ ${LIMITS.driftH}`),
    check("hold: altitude drift (m)", d.z, d.z <= LIMITS.driftZ, `≤ ${LIMITS.driftZ}`),
    check("hold: heading drift (°)", d.heading, d.heading <= LIMITS.driftHeading, `≤ ${LIMITS.driftHeading}`),
  ];
}

async function collect(t0, waitMs) {
  await sleep(waitMs);
  const samples = await chain.simClient.samples(t0 - 2_500);
  const air = chain.air && !chain.air.isClosed() ? await airLog(t0 - 2_500).catch(() => []) : [];
  return { samples, air };
}

// --- scenarios ----------------------------------------------------------------------------

/** Common shape for "the heartbeat stops" faults (1, 2, 3). */
async function heartbeatLoss(t0, { neutralFromFc = true } = {}) {
  const { samples, air } = await collect(t0, LIMITS.settleMs + LIMITS.windowMs + 500);
  const neutral = firstLog(air, t0, (e) => e.sup === "NEUTRAL");
  const released = firstLog(air, t0, (e) => e.sup === "RELEASED");
  const tCenter = rel(firstAt(samples, t0, "center"), t0);
  const lastPp = rel(lastAt(samples, t0, "pp"), t0);
  const checks = [
    check("air NEUTRAL (ms)", rel(neutral?.t, t0), neutral && neutral.t - t0 <= LIMITS.neutralMs, `≤ ${LIMITS.neutralMs}`),
    check("air RELEASED (ms)", rel(released?.t, t0), released && released.t - t0 <= LIMITS.releaseMs, `≤ ${LIMITS.releaseMs}`),
    check("FC on the SP's sticks", rel(firstAt(samples, t0, "sp"), t0), firstAt(samples, t0, "sp") !== undefined, "yes"),
    check("no PP command applied after the neutral timeout (last PP sample, ms)", lastPp, lastPp === null || lastPp <= LIMITS.neutralMs + 60, `≤ ${LIMITS.neutralMs + 60}`),
    ...driftChecks(drift(samples, t0)),
  ];
  if (neutralFromFc) checks.splice(1, 0, check("FC sticks centered (ms)", tCenter, tCenter !== null && tCenter <= LIMITS.neutralMs + 60, `≤ ${LIMITS.neutralMs + 60}`));
  return { checks, samples };
}

/** Faults where the air can't send at all (5, 6): the FC's own stale-override fallback. */
/** ms from the last MSP_SET_RAW_RC the FC received to the first sample on the SP's sticks. */
function afterLastFrame(samples, from) {
  const tSpAbs = firstAt(samples, from, "sp");
  const lastFrame = chain.proxy.chunks
    .filter((c) => c.dir === "toFc" && c.t <= (tSpAbs ?? Infinity) && mspFrames(c.bytes).includes(200))
    .at(-1)?.t;
  return tSpAbs !== undefined && lastFrame !== undefined ? Math.round(tSpAbs - lastFrame) : null;
}

async function fcFallback(t0) {
  const { samples, air } = await collect(t0, LIMITS.settleMs + LIMITS.windowMs + 500);
  const tSpAbs = firstAt(samples, t0, "sp");
  const tSp = rel(tSpAbs, t0);
  const lastPp = rel(lastAt(samples, t0, "pp"), t0);
  // Betaflight's stale-override timer runs from the last frame it received, which can be a few
  // tens of ms after t0 (the fault takes effect asynchronously): anchor on the proxy's capture.
  const lastFrame = chain.proxy.chunks
    .filter((c) => c.dir === "toFc" && c.t <= (tSpAbs ?? Infinity) && mspFrames(c.bytes).includes(200))
    .at(-1)?.t;
  const afterLastFrame = tSpAbs !== undefined && lastFrame !== undefined ? Math.round(tSpAbs - lastFrame) : null;
  return {
    air,
    samples,
    checks: [
      check("FC back on the SP's sticks after the last frame (ms)", afterLastFrame, afterLastFrame !== null && afterLastFrame <= LIMITS.fcFallbackMs, `≤ ${LIMITS.fcFallbackMs}`),
      check("... after the fault (ms, measured)", tSp, tSp !== null, "report"),
      check("no PP command after the fallback (last PP sample, ms)", lastPp, lastPp === null || (tSp !== null && lastPp < tSp), "before the fallback"),
      ...driftChecks(drift(samples, t0)),
    ],
  };
}

const SCENARIOS = [
  {
    id: "1",
    name: "Ground GUI tab blurred (odd runs) / closed (even runs)",
    async run(runIndex) {
      const t0 = await establishFlying();
      if (runIndex % 2 === 1) {
        await chain.gui.evaluate(() => window.dispatchEvent(new Event("blur")));
      } else {
        await chain.gui.close();
      }
      const r = await heartbeatLoss(t0);
      return { ...r, variant: runIndex % 2 === 1 ? "blurred" : "closed" };
    },
  },
  {
    id: "2",
    name: "ground-core-node killed",
    async run() {
      const t0 = await establishFlying();
      kill(chain.ground);
      return heartbeatLoss(t0);
    },
  },
  {
    id: "3",
    name: "Network blackhole between ground and air",
    requires: "root",
    async run() {
      await establishFlying();
      chain.impair = start("netimpair", "python3", [join(HERE, "netimpair.py"), "blackhole"], { ready: /active/ });
      await chain.impair.ready;
      return heartbeatLoss(Date.now()); // the fault starts when the rule is in place
    },
  },
  ...[
    ["4a", 500],
    ["4b", 2000],
  ].map(([id, ms]) => ({
    id,
    name: `${ms} ms latency + 20 % loss`,
    requires: "nfqueue",
    async run() {
      await establishFlying();
      chain.impair = start("netimpair", "python3", [join(HERE, "netimpair.py"), "delay", "--ms", String(ms), "--loss", "20"], { ready: /active/ });
      await chain.impair.ready;
      const t0 = Date.now(); // the fault starts when the rule is in place
      const { samples, air } = await collect(t0, 12_000);
      const gui = await guiLog(t0);
      const gate = gui.find((e) => /round trip above|too late/.test(e.deadman));
      const gateT = gate ? gate.t : null;
      const lastPp = rel(lastAt(samples, t0, "pp"), t0);
      // Commands sent before the gate still drain through the lossy, congested link; what must
      // hold is that the air stops applying them on its own timeout, within a bounded time.
      const lastActiveEnd = air.filter((e) => e.sup === "NEUTRAL" || e.sup === "ABORTED" || e.sup === "RELEASED").find((e) => !air.some((later) => later.t > e.t && later.sup === "ACTIVE"));
      const drainLimit = gateT === null ? null : rel(gateT, t0) + 3 * ms + 500;
      const released = lastActiveEnd ? firstLog(air, lastActiveEnd.t, (e) => e.sup === "RELEASED") : null;
      const final = air.at(-1);
      const firstNeutral = firstLog(air, t0, (e) => e.sup !== "ACTIVE");
      return {
        samples,
        checks: [
          check("ground gate (RTT or command age) stopped the stream (ms)", rel(gateT, t0), gateT !== null && gateT - t0 <= 5_000, "≤ 5000"),
          check("first air NEUTRAL from late/lost commands (ms, measured)", rel(firstNeutral?.t, t0), true, "report"),
          check("air stopped applying commands for good (ms)", rel(lastActiveEnd?.t, t0), lastActiveEnd && drainLimit !== null && rel(lastActiveEnd.t, t0) <= drainLimit, drainLimit === null ? "gate" : `≤ gate + 3 × delay + 500 = ${drainLimit}`),
          check("no PP command after that (last PP sample, ms)", lastPp, lastActiveEnd && (lastPp === null || lastPp <= rel(lastActiveEnd.t, t0) + 60), lastActiveEnd ? `≤ ${rel(lastActiveEnd.t, t0) + 60}` : "n/a"),
          check("air RELEASED (ms)", rel(released?.t, t0), released && lastActiveEnd && released.t - lastActiveEnd.t <= LIMITS.releaseMs + 100, "≤ that + 1100"),
          check("ends released, not flying", final?.sup, final?.sup === "RELEASED" || final?.sup === "IDLE", "RELEASED"),
        ],
      };
    },
  })),
  {
    id: "5",
    name: "Air tab frozen (debugger pause), 3 s",
    async run() {
      const t0 = await establishFlying();
      const cdp = await chain.air.context().newCDPSession(chain.air);
      await cdp.send("Debugger.enable");
      await cdp.send("Debugger.pause");
      await sleep(3_000);
      await cdp.send("Debugger.resume");
      await cdp.detach().catch(() => undefined);
      const r = await fcFallback(t0);
      // After the freeze the air must not fly the backlog: its telemetry is stale.
      const resumedPp = r.samples.filter((s) => s[0] >= t0 + 3_000 && classify(s) === "pp").length;
      r.checks.push(check("no PP command after the air resumed (samples)", resumedPp, resumedPp === 0, "0"));
      const released = firstLog(r.air, t0 + 3_000, (e) => e.sup === "RELEASED");
      r.checks.push(check("air RELEASED once it resumed", released ? `${released.reason}` : "no", released, "yes"));
      return r;
    },
  },
  {
    id: "6",
    name: "Serial bridge to SITL killed (≈ USB unplug)",
    async run() {
      const t0 = await establishFlying();
      kill(chain.bridge);
      const r = await fcFallback(t0);
      const lost = firstLog(r.air, t0, (e) => e.sup === "RELEASED");
      r.checks.push(check("air reports fc-link-lost (ms)", lost ? `${rel(lost.t, t0)} (${lost.reason})` : "no", lost && lost.reason === "fc-link-lost", "fc-link-lost"));
      return r;
    },
  },
  {
    id: "7",
    name: "ABORT pressed (keys still held for 3 s)",
    async run() {
      const t0 = await establishFlying();
      await chain.gui.keyboard.press("Space");
      const { samples, air } = await collect(t0, LIMITS.settleMs + LIMITS.windowMs + 500);
      const aborted = firstLog(air, t0, (e) => e.sup === "ABORTED");
      const stillAborted = air.filter((e) => e.t <= t0 + 3_000).at(-1);
      const tCenter = rel(firstAt(samples, t0, "center"), t0);
      const lastPp = rel(lastAt(samples, t0, "pp"), t0);
      return {
        samples,
        checks: [
          check("air ABORTED (ms)", rel(aborted?.t, t0), aborted && aborted.t - t0 <= LIMITS.neutralMs, `≤ ${LIMITS.neutralMs}`),
          check("FC sticks centered (ms)", tCenter, tCenter !== null && tCenter <= LIMITS.neutralMs, `≤ ${LIMITS.neutralMs}`),
          check("commands ignored while held (last PP sample, ms)", lastPp, lastPp === null || lastPp <= LIMITS.neutralMs, `≤ ${LIMITS.neutralMs}`),
          check("still ABORTED 3 s later (heartbeat alive)", stillAborted?.sup, stillAborted?.sup === "ABORTED", "ABORTED"),
          ...driftChecks(drift(samples, t0)),
        ],
      };
    },
  },
  {
    id: "8",
    name: "ABORT, then link loss (GUI closed 1.5 s later)",
    async run() {
      const t0 = await establishFlying();
      await chain.gui.keyboard.press("Space");
      await sleep(1_500);
      const tLoss = Date.now();
      await chain.gui.close();
      const { samples, air } = await collect(t0, LIMITS.settleMs + LIMITS.windowMs + 500);
      const released = firstLog(air, tLoss, (e) => e.sup === "RELEASED");
      const lastPp = rel(lastAt(samples, t0, "pp"), t0);
      const tSp = rel(firstAt(samples, tLoss, "sp"), tLoss);
      return {
        samples,
        checks: [
          check("hovering (centered) until the loss", classify(samples.filter((s) => s[0] < tLoss).at(-1)), classify(samples.filter((s) => s[0] < tLoss).at(-1)) === "center", "center"),
          check("air RELEASED after the loss (ms)", rel(released?.t, tLoss), released && released.t - tLoss <= LIMITS.releaseMs, `≤ ${LIMITS.releaseMs}`),
          check("then the SP has control (ms after loss)", tSp, tSp !== null && tSp <= LIMITS.releaseMs + LIMITS.fcFallbackMs, `≤ ${LIMITS.releaseMs + LIMITS.fcFallbackMs}`),
          check("no PP command after ABORT (last PP sample, ms)", lastPp, lastPp === null || lastPp <= LIMITS.neutralMs, `≤ ${LIMITS.neutralMs}`),
          ...driftChecks(drift(samples, t0)),
        ],
      };
    },
  },
  {
    id: "9",
    name: "SP flips the handover switch back mid-command",
    async run() {
      const t0 = await establishFlying();
      await chain.simClient.pilot({ override: false });
      const { samples, air } = await collect(t0, LIMITS.settleMs + LIMITS.windowMs + 500);
      const gui = await guiLog(t0);
      const tSp = rel(firstAt(samples, t0, "sp"), t0);
      const lastPp = rel(lastAt(samples, t0, "pp"), t0);
      const released = firstLog(air, t0, (e) => e.sup === "RELEASED");
      const banner = gui.find((e) => e.banner === "Safety pilot took back control");
      return {
        samples,
        checks: [
          check("FC on the SP's sticks (ms)", tSp, tSp !== null && tSp <= LIMITS.spTakebackMs, `≤ ${LIMITS.spTakebackMs}`),
          check("no PP command after the takeback (last PP sample, ms)", lastPp, lastPp === null || lastPp <= LIMITS.spTakebackMs, `≤ ${LIMITS.spTakebackMs}`),
          check("air RELEASED: sp-took-control", released ? `${rel(released.t, t0)} ms (${released.reason})` : "no", released?.reason === "sp-took-control", "sp-took-control"),
          check("GUI shows \"Safety pilot took back control\" (ms)", rel(banner?.t, t0), banner && banner.t - t0 <= 1_000, "≤ 1000"),
          ...driftChecks(drift(samples, t0)),
        ],
      };
    },
  },
  {
    id: "10",
    name: "SP switches out of POS HOLD while the PP holds climb",
    async run() {
      const t0 = await establishFlying();
      await chain.simClient.pilot({ hold: false });
      const { samples, air } = await collect(t0, 2_000);
      await chain.simClient.pilot({ hold: true });
      const modeDrop = samples.find((s) => s[0] >= t0 && !s[2].includes(BOX.POSHOLD));
      const released = firstLog(air, t0, (e) => e.sup === "RELEASED");
      const tSp = firstAt(samples, t0, "sp");
      const exposure = modeDrop && tSp ? Math.round(tSp - modeDrop[0]) : null;
      const atDrop = modeDrop ?? samples.find((s) => s[0] >= t0);
      const atSp = samples.find((s) => s[0] >= (tSp ?? Infinity));
      const climb = atDrop && atSp ? +(atSp[5] - atDrop[5]).toFixed(2) : null;
      return {
        samples,
        checks: [
          check("air RELEASED: pos-hold-lost (ms after the FC dropped POS HOLD)", released && modeDrop ? `${Math.round(released.t - modeDrop[0])} (${released.reason})` : "no",
            released?.reason === "pos-hold-lost" && modeDrop && released.t - modeDrop[0] <= 300, "≤ 300"),
          check("raw-throttle exposure window (ms, measured)", exposure, exposure !== null && exposure <= LIMITS.fcFallbackMs + 300, `≤ ${LIMITS.fcFallbackMs + 300}`),
          check("altitude change during the exposure (m, measured)", climb, climb !== null, "report"),
        ],
      };
    },
  },
  {
    id: "11",
    name: "RC loss (SP's TX off)",
    async run() {
      const t0 = await establishFlying();
      await chain.simClient.pilot({ link: false });
      const { samples, air } = await collect(t0, 6_000);
      await chain.simClient.pilot({ link: true });
      const failsafe = samples.find((s) => s[0] >= t0 && s[2].includes(BOX.FAILSAFE));
      const released = firstLog(air, t0, (e) => e.sup === "RELEASED");
      const start = samples.find((s) => s[0] >= t0);
      const end = samples.at(-1);
      return {
        samples,
        destructive: true,
        checks: [
          check("Betaflight FAILSAFE engaged (ms)", rel(failsafe?.[0], t0), failsafe && failsafe[0] - t0 <= 2_500, "≤ 2500"),
          check("air RELEASED", released ? `${rel(released.t, t0)} ms (${released.reason})` : "no", released, "yes"),
          check("failsafe descends (auto-land), m in 6 s", start && end ? +(end[5] - start[5]).toFixed(2) : null, start && end && end[5] < start[5] - 0.5, "< -0.5"),
        ],
      };
    },
  },
  {
    id: "12",
    name: "Air reconnects after a drop (page reload)",
    async run() {
      const t0 = await establishFlying();
      await guiReleaseKeys(FLY_KEYS);
      await airOpen(); // drop + reconnect, the switch still on
      await waitFor("FC verified after reconnect", async () => (await airNow())?.mode === "verified", 15_000);
      await sleep(3_000);
      const log = await airLog(0);
      const handedOver = log.some((e) => e.sup === "HANDED_OVER");
      const reason = log.at(-1)?.reason;
      await guiOpen();
      const offered = await chain.gui.evaluate(() => !document.querySelector(".fcp-take")?.disabled).catch(() => false);
      // Fresh handover + unlock works.
      await chain.simClient.pilot({ override: false });
      await waitSwitchSeenOff();
      await chain.simClient.pilot({ override: true });
      const ho = await waitFor("HANDED_OVER", async () => (await airNow())?.sup === "HANDED_OVER", 6_000).catch(() => false);
      let unlocked = false;
      if (ho) unlocked = await guiUnlock().then(() => true, () => false);
      const samples = await chain.simClient.samples(t0 - 2_500);
      const tSp = rel(firstAt(samples, t0, "sp"), t0);
      return {
        samples,
        checks: [
          check("FC back on the SP's sticks during the drop, after the last frame (ms)", afterLastFrame(samples, t0), afterLastFrame(samples, t0) !== null && afterLastFrame(samples, t0) <= LIMITS.fcFallbackMs, `≤ ${LIMITS.fcFallbackMs}`),
          check("... after the drop (ms, measured)", tSp, tSp !== null, "report"),
          check("locked after reconnect: no HANDED_OVER with the switch left on", handedOver ? "handed over" : reason, !handedOver && reason === "awaiting-fresh-handover", "awaiting-fresh-handover"),
          check("GUI does not offer the unlock", offered ? "offered" : "not offered", !offered, "not offered"),
          check("fresh handover + unlock works", unlocked ? "ACTIVE" : "no", unlocked, "ACTIVE"),
        ],
      };
    },
  },
  {
    id: "13",
    name: "Commands before unlock (in HANDED_OVER)",
    async run() {
      await ensureChain();
      await ensureAirborne();
      await chain.simClient.pilot({ ...SP, hold: true });
      if (!(await airNow())?.enabled) await airSetEnabled(true);
      await waitFor("FC verified", async () => (await airNow())?.mode === "verified", 15_000);
      await chain.simClient.pilot({ override: false });
      await waitSwitchSeenOff();
      await chain.simClient.pilot({ override: true });
      await waitFor("HANDED_OVER", async () => (await airNow())?.sup === "HANDED_OVER", 6_000);
      // The previous scenario's last frames stay applied for Betaflight's 300 ms stale window.
      await waitFor("FC on the SP's sticks", async () => {
        const recent = await chain.simClient.samples(Date.now() - 200);
        return recent.length > 3 && recent.every((s) => classify(s) === "sp");
      }, 3_000);
      const t0 = Date.now();
      // A rogue client streams full-deflection commands; the GUI user mashes the keys.
      const ws = new WebSocket(`wss://localhost:${PORTS.signal}/gui-signaling`, { rejectUnauthorized: false });
      await new Promise((r) => ws.once("open", r));
      let seq = 1_000_000;
      const timer = setInterval(() => ws.send(JSON.stringify({ type: "fc-command", seq: seq++, sentAt: Date.now(), roll: 1, pitch: 1, yaw: 1, throttle: 1 })), 50);
      await guiHoldKeys(FLY_KEYS);
      await sleep(3_000);
      clearInterval(timer);
      ws.close();
      await guiReleaseKeys(FLY_KEYS);
      const samples = await chain.simClient.samples(t0);
      const air = await airLog(t0);
      const toFc = chain.proxy.bytes("toFc", t0);
      const setRawRc = mspFrames(toFc).filter((c) => c === 200).length;
      const offSp = samples.filter((s) => classify(s) !== "sp");
      const nonSp = offSp.length;
      return {
        samples,
        checks: [
          check("still HANDED_OVER (locked)", air.at(-1)?.sup ?? (await airNow())?.sup, (air.at(-1)?.sup ?? (await airNow())?.sup) === "HANDED_OVER", "HANDED_OVER"),
          check("MSP_SET_RAW_RC frames written to the FC", setRawRc, setRawRc === 0, "0"),
          check("FC samples not on the SP's sticks", nonSp ? `${nonSp}: ${JSON.stringify(offSp.slice(0, 3).map((s) => [Math.round(s[0] - t0), s[1].slice(0, 4), s[7].slice(0, 4)]))}` : 0, nonSp === 0, "0"),
        ],
      };
    },
  },
  {
    id: "14a",
    name: "FC reboot mid-session",
    async run() {
      const t0 = await establishFlying();
      await guiReleaseKeys(FLY_KEYS);
      await chain.simClient.call("restart");
      await airConnectFc().catch(() => undefined);
      await waitFor("FC verified after reboot", async () => (await airNow())?.mode === "verified", 20_000).catch(() => undefined);
      const t1 = Date.now();
      await sleep(4_000);
      const air = await airLog(t0);
      const toFc = chain.proxy.bytes("toFc", t0 + 500);
      const frames = mspFrames(toFc);
      const firstRawRc = frames.indexOf(200);
      const probes = frames.indexOf(1);
      return {
        destructive: true,
        samples: [],
        checks: [
          check("air re-identified (verified)", air.some((e) => e.t >= t0 + 500 && e.mode === "verified") ? "yes" : "no", air.some((e) => e.t >= t0 + 500 && e.mode === "verified"), "yes"),
          check("identification probes after the reboot", probes >= 0 ? "yes" : "no", probes >= 0, "yes"),
          check("MSP_SET_RAW_RC after the reboot (frames)", frames.filter((c) => c === 200).length, firstRawRc < 0, "0"),
          check("air not handed over after the reboot", (await airNow())?.sup, (await airNow())?.sup !== "HANDED_OVER" && (await airNow())?.sup !== "ACTIVE", "IDLE/RELEASED"),
          check("FC rebooted disarmed (time to verified, ms)", rel(t1, t0), true, "report"),
        ],
      };
    },
  },
  {
    id: "14b",
    name: "FC swapped for an unsupported Betaflight build (2025.12.5 identity, scripted MSP responder)",
    async run() {
      await ensureChain();
      if (!(await airNow())?.enabled) await airSetEnabled(true);
      const t0 = Date.now();
      chain.proxy.upstream = { kind: "fake", make: fakeBetaflight2025 };
      chain.proxy.dropAll();
      await sleep(500);
      await airConnectFc().catch(() => undefined);
      const done = await waitFor("gate result", async () => {
        const now = await airNow();
        return now?.mode === "transparent" && now.linkReason !== "link-opened" && now.linkReason !== "setting-disabled" ? now : null;
      }, 20_000).catch(() => null);
      await sleep(3_000);
      const frames = mspFrames(chain.proxy.bytes("toFc", t0));
      chain.proxy.upstream = { kind: "sitl" };
      chain.proxy.dropAll();
      await sleep(500);
      await airConnectFc().catch(() => undefined);
      return {
        samples: [],
        checks: [
          check("gate: transparent", done ? done.linkReason : "no result", ["unsupported-api-version", "unsupported-firmware-version"].includes(done?.linkReason), "unsupported-*"),
          check("MSP_SET_RAW_RC frames", frames.filter((c) => c === 200).length, !frames.includes(200), "0"),
          check("only identification probes written", [...new Set(frames)].join(","), frames.every((c) => [1, 2, 3].includes(c)), "1,2,3"),
        ],
      };
    },
  },
  {
    id: "14c",
    name: "FC swapped for INAV (synthetic MSP responder)",
    async run() {
      await ensureChain();
      if (!(await airNow())?.enabled) await airSetEnabled(true);
      const t0 = Date.now();
      chain.proxy.upstream = { kind: "fake", make: fakeInav };
      chain.proxy.dropAll();
      await sleep(500);
      await airConnectFc().catch(() => undefined);
      const done = await waitFor("gate result", async () => {
        const now = await airNow();
        return now?.mode === "transparent" && !["link-opened", "setting-disabled"].includes(now.linkReason) ? now : null;
      }, 20_000).catch(() => null);
      await sleep(2_000);
      const frames = mspFrames(chain.proxy.bytes("toFc", t0));
      chain.proxy.upstream = { kind: "sitl" };
      chain.proxy.dropAll();
      await sleep(500);
      await airConnectFc().catch(() => undefined);
      return {
        samples: [],
        checks: [
          check("gate: transparent", done ? done.linkReason : "no result", done && /unsupported/.test(done.linkReason), "unsupported-*"),
          check("MSP_SET_RAW_RC frames", frames.filter((c) => c === 200).length, !frames.includes(200), "0"),
        ],
      };
    },
  },
  {
    id: "15",
    name: "flightControlEnabled turned off mid-command (air UI)",
    async run() {
      const t0 = await establishFlying();
      await chain.air.evaluate(() => document.querySelector(".dl-fcp__toggle input").click());
      const { samples, air } = await collect(t0, LIMITS.settleMs + LIMITS.windowMs + 500);
      const released = firstLog(air, t0, (e) => e.sup === "RELEASED" || e.sup === "IDLE");
      const transparent = firstLog(air, t0, (e) => e.mode === "transparent");
      const tSp = rel(firstAt(samples, t0, "sp"), t0);
      const lastPp = rel(lastAt(samples, t0, "pp"), t0);
      await airSetEnabled(true);
      return {
        samples,
        checks: [
          check("air released (ms)", released ? `${rel(released.t, t0)} (${released.reason})` : "no", released && released.t - t0 <= 100, "≤ 100"),
          check("link transparent (ms)", rel(transparent?.t, t0), transparent && transparent.t - t0 <= 100, "≤ 100"),
          check("FC on the SP's sticks after the last frame (ms)", afterLastFrame(samples, t0), afterLastFrame(samples, t0) !== null && afterLastFrame(samples, t0) <= LIMITS.fcFallbackMs, `≤ ${LIMITS.fcFallbackMs}`),
          check("... after the switch-off (ms, measured)", tSp, tSp !== null, "report"),
          check("no PP command after that (last PP sample, ms)", lastPp, lastPp === null || (tSp !== null && lastPp < tSp), "before it"),
          ...driftChecks(drift(samples, t0)),
        ],
      };
    },
  },
  {
    id: "16",
    name: "Setting off + Configurator session over the ground TCP bridge",
    async run() {
      await ensureChain();
      await chain.simClient.pilot({ override: false });
      await waitFor("air IDLE/RELEASED", async () => ["IDLE", "RELEASED"].includes((await airNow())?.sup), 6_000);
      await airSetEnabled(false);
      await sleep(2_500);
      const t0 = Date.now();
      // A Configurator-like session: 300 request/reply round trips, mixed sizes.
      const sock = createConnection({ host: "127.0.0.1", port: PORTS.groundBridge });
      await new Promise((r, j) => (sock.once("connect", r), sock.once("error", j)));
      const sent = [];
      const received = [];
      let pending = null;
      let buf = Buffer.alloc(0);
      sock.on("data", (d) => {
        received.push(Buffer.from(d));
        buf = Buffer.concat([buf, d]);
        if (pending && mspFrames(buf, 0x3e).length > 0) {
          buf = Buffer.alloc(0);
          const r = pending;
          pending = null;
          r();
        }
      });
      const commands = [1, 2, 3, 4, 5, 101, 105, 106, 108, 109, 110, 116, 119, 150];
      let timeouts = 0;
      const unanswered = new Set();
      for (let i = 0; i < 300; i++) {
        const frame = mspRequest(commands[i % commands.length]);
        sent.push(frame);
        const replied = new Promise((r) => (pending = r));
        sock.write(frame);
        const ok = await Promise.race([replied.then(() => true), sleep(1_000).then(() => false)]);
        if (!ok) {
          timeouts++;
          unanswered.add(commands[i % commands.length]);
          pending = null;
          buf = Buffer.alloc(0);
        }
      }
      await sleep(1_000);
      sock.destroy();
      const t1 = Date.now();
      await sleep(2_000); // idle: nothing may be written
      const toFc = chain.proxy.bytes("toFc", t0, t1);
      const fromFc = chain.proxy.bytes("fromFc", t0, t1);
      const clientSent = Buffer.concat(sent);
      const clientGot = Buffer.concat(received);
      const idleWrites = chain.proxy.bytes("toFc", t1, Date.now()).length;
      await airSetEnabled(true);
      return {
        samples: [],
        checks: [
          check("round trips answered", `${300 - timeouts}${unanswered.size ? ` (no reply to ${[...unanswered].join(",")})` : ""}`, timeouts === 0, "300"),
          check("FC received exactly the client's bytes", `${toFc.length} vs ${clientSent.length} B`, toFc.equals(clientSent), "identical"),
          check("client received exactly the FC's bytes", `${clientGot.length} vs ${fromFc.length} B`, clientGot.equals(fromFc), "identical"),
          check("bytes written to the FC while idle", idleWrites, idleWrites === 0, "0"),
        ],
      };
    },
  },
  {
    id: "17",
    name: "Setting on + non-MSP link (MAVLink v2 stream)",
    async run() {
      await ensureChain();
      if (!(await airNow())?.enabled) await airSetEnabled(true);
      chain.proxy.upstream = { kind: "fake", make: fakeMavlink };
      chain.proxy.dropAll();
      await sleep(500);
      const t0 = Date.now();
      await airConnectFc().catch(() => undefined);
      await sleep(6_000);
      const air = await airLog(t0);
      const toFc = chain.proxy.bytes("toFc", t0);
      const last = air.at(-1) ?? (await airNow());
      chain.proxy.upstream = { kind: "sitl" };
      chain.proxy.dropAll();
      await sleep(500);
      await airConnectFc().catch(() => undefined);
      return {
        samples: [],
        checks: [
          check("classified", last?.detected, last?.detected === "mavlink-v2", "mavlink-v2"),
          check("stays transparent", `${last?.mode} (${last?.linkReason})`, last?.mode === "transparent", "transparent"),
          check("bytes written to the FC (no probes)", toFc.length, toFc.length === 0, "0"),
        ],
      };
    },
  },
];

// --- runner -------------------------------------------------------------------------------

function environmentSupports(requirement) {
  if (!requirement) return null;
  const root = process.getuid?.() === 0;
  if (!root) return "needs root (iptables)";
  if (requirement === "nfqueue") {
    try {
      execFileSync("python3", ["-c", "import netfilterqueue"], { stdio: "ignore" });
    } catch {
      return "needs the NetfilterQueue Python package";
    }
  }
  return null;
}

async function main() {
  const selected = SCENARIOS.filter((s) => !ONLY || ONLY.includes(s.id) || ONLY.includes(s.id.replace(/[a-z]$/, "")));
  const results = [];
  const auxTotals = { samples: 0, mismatches: 0 };
  console.log(`drills: ${selected.map((s) => s.id).join(", ")} x ${RUNS}; logs in ${WORK}`);
  try {
    await setup();
    for (let run = 1; run <= RUNS; run++) {
      for (const scenario of selected) {
        const skip = environmentSupports(scenario.requires);
        if (skip) {
          results.push({ id: scenario.id, name: scenario.name, run, skipped: skip });
          console.log(`[run ${run}] ${scenario.id} SKIP (${skip})`);
          continue;
        }
        const started = Date.now();
        let outcome;
        try {
          outcome = await scenario.run(run);
        } catch (error) {
          outcome = { checks: [check("scenario ran", String(error?.message ?? error), false, "")], samples: [] };
        }
        await afterScenario().catch(() => undefined);
        const aux = auxMismatches(outcome.samples ?? []);
        auxTotals.samples += outcome.samples?.length ?? 0;
        auxTotals.mismatches += aux;
        const pass = outcome.checks.every((c) => c.pass);
        results.push({ id: scenario.id, name: scenario.name, run, variant: outcome.variant, pass, durationS: Math.round((Date.now() - started) / 1000), checks: outcome.checks, auxMismatches: aux });
        console.log(`[run ${run}] ${scenario.id} ${pass ? "PASS" : "FAIL"} ${scenario.name}`);
        for (const c of outcome.checks) if (!c.pass || process.env.DRILLS_VERBOSE) console.log(`      ${c.pass ? "ok  " : "FAIL"} ${c.name}: ${JSON.stringify(c.value)} (${c.limit})`);
        writeFileSync(join(OUT, "results.json"), JSON.stringify({ limits: LIMITS, sp: SP, runs: RUNS, results, aux: auxTotals }, null, 2));
      }
    }
  } finally {
    await teardown();
  }
  results.push({ id: "18", name: "AUX channels never changed by the link (all scenarios)", run: "all", pass: auxTotals.mismatches === 0, checks: [check("AUX mismatches", `${auxTotals.mismatches} in ${auxTotals.samples} samples`, auxTotals.mismatches === 0, "0")] });
  writeFileSync(join(OUT, "results.json"), JSON.stringify({ limits: LIMITS, sp: SP, runs: RUNS, results, aux: auxTotals }, null, 2));
  const failed = results.filter((r) => r.pass === false);
  console.log(`\n${results.filter((r) => r.pass).length} passed, ${failed.length} failed, ${results.filter((r) => r.skipped).length} skipped -> ${join(OUT, "results.json")}`);
  process.exit(failed.length > 0 ? 1 : 0); // the capture proxy would keep the event loop alive
}

for (const sig of ["SIGINT", "SIGTERM"]) {
  process.on(sig, () => {
    void teardown().finally(() => process.exit(130));
  });
}

await main();
