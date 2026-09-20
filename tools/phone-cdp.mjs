#!/usr/bin/env node
// Drive the Android shell's WebView over Chrome DevTools, no pixel taps needed.
//   node tools/phone-cdp.mjs eval "document.title"
//   node tools/phone-cdp.mjs text                    # visible text of the page
//   node tools/phone-cdp.mjs click "button.pair"     # CSS selector
//   node tools/phone-cdp.mjs type "textarea" "<value>"
//   node tools/phone-cdp.mjs shot out.png
//   node tools/phone-cdp.mjs pair '<pairing bundle json>'
//   node tools/phone-cdp.mjs disconnect
import { writeFileSync } from "node:fs";
import { adb } from "./lib.mjs";

const PORT = 9222;

function findSocket() {
  const unix = adb("shell", "cat /proc/net/unix").out;
  const names = [...unix.matchAll(/@(webview_devtools_remote_\d+)/g)].map((m) => m[1]);
  if (names.length === 0) throw new Error("No WebView devtools socket; is the app running (debug build)?");
  return names[names.length - 1];
}

async function connect() {
  const forward = adb("forward", `tcp:${PORT}`, `localabstract:${findSocket()}`);
  if (!forward.ok) throw new Error(`adb forward failed: ${forward.err}`);
  const targets = await (await fetch(`http://127.0.0.1:${PORT}/json`)).json();
  const page = targets.find((t) => t.type === "page");
  if (!page) throw new Error("No page target in the WebView");
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((res, rej) => {
    ws.onopen = res;
    ws.onerror = () => rej(new Error("devtools websocket failed"));
  });
  let id = 0;
  const pending = new Map();
  ws.onmessage = (ev) => {
    const msg = JSON.parse(ev.data);
    const p = pending.get(msg.id);
    if (!p) return;
    pending.delete(msg.id);
    if (msg.error) p.rej(new Error(msg.error.message));
    else p.res(msg.result);
  };
  const send = (method, params = {}) =>
    new Promise((res, rej) => {
      const myId = ++id;
      pending.set(myId, { res, rej });
      ws.send(JSON.stringify({ id: myId, method, params }));
    });
  return { send, close: () => ws.close() };
}

async function evaluate(cdp, expression) {
  const r = await cdp.send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text);
  return r.result.value;
}

const [cmd, a, b] = process.argv.slice(2);
const cdp = await connect();
try {
  if (cmd === "eval") {
    console.log(JSON.stringify(await evaluate(cdp, a), null, 2));
  } else if (cmd === "text") {
    console.log(await evaluate(cdp, "document.body.innerText"));
  } else if (cmd === "click") {
    const sel = JSON.stringify(a);
    console.log(await evaluate(cdp, `(() => { const e = document.querySelector(${sel}); if (!e) return "not found"; e.click(); return "clicked"; })()`));
  } else if (cmd === "type") {
    const sel = JSON.stringify(a);
    const val = JSON.stringify(b ?? "");
    console.log(
      await evaluate(
        cdp,
        `(() => { const e = document.querySelector(${sel}); if (!e) return "not found"; const proto = Object.getPrototypeOf(e); Object.getOwnPropertyDescriptor(proto, "value").set.call(e, ${val}); e.dispatchEvent(new Event("input", { bubbles: true })); e.dispatchEvent(new Event("change", { bubbles: true })); return "set"; })()`,
      ),
    );
  } else if (cmd === "pair") {
    const bundle = JSON.stringify(a ?? "");
    console.log(
      await evaluate(
        cdp,
        `(async () => {
          const link = [...document.querySelectorAll("button")].find((x) => /binding phrase/i.test(x.textContent));
          if (link) link.click();
          const area = document.querySelector("textarea");
          if (!area) return "binding form not found (already paired?)";
          Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value").set.call(area, ${bundle});
          area.dispatchEvent(new Event("input", { bubbles: true }));
          document.querySelector(".dl-ground__pair-button").click();
          return "pair clicked";
        })()`,
      ),
    );
  } else if (cmd === "disconnect") {
    console.log(await evaluate(cdp, `(() => { const b = document.querySelector(".dl-disconnect"); if (!b) return "not found"; b.click(); return "clicked"; })()`));
  } else if (cmd === "shot") {
    const { data } = await cdp.send("Page.captureScreenshot", { format: "png" });
    writeFileSync(a ?? "phone.png", Buffer.from(data, "base64"));
    console.log(`saved ${a ?? "phone.png"}`);
  } else {
    console.error("usage: phone-cdp.mjs eval|text|click|type|pair|disconnect|shot ...");
    process.exitCode = 2;
  }
} finally {
  cdp.close();
}
