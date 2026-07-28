/**
 * serial-test.ts — entry point for the Phase 0 serial spike test page (serial-test.html).
 *
 * Wires up the Connect / Disconnect buttons to WebSerialTransport and renders:
 *   - a live "bytes received" counter
 *   - a "last byte at HH:MM:SS.mmm" timestamp
 *   - a scrolling hex dump of every received chunk
 *
 * This file is NOT part of the main app bundle. It is a standalone development
 * harness used to confirm the USB-serial hardware path works, independent of
 * pairing / WebRTC / protocol parsing.
 */

import { WebSerialTransport } from "./transport/WebSerialTransport.js";

// ---------------------------------------------------------------------------
// DOM references
// ---------------------------------------------------------------------------

const btnConnect = document.getElementById("btn-connect") as HTMLButtonElement;
const btnDisconnect = document.getElementById("btn-disconnect") as HTMLButtonElement;
const statusIndicator = document.getElementById("status-indicator") as HTMLSpanElement;
const byteCounter = document.getElementById("byte-counter") as HTMLSpanElement;
const lastTs = document.getElementById("last-ts") as HTMLSpanElement;
const logDiv = document.getElementById("log") as HTMLDivElement;
const logCount = document.getElementById("log-count") as HTMLSpanElement;
const errorBanner = document.getElementById("error-banner") as HTMLDivElement;

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

let transport: WebSerialTransport | null = null;
let totalBytes = 0;
let chunkCount = 0;
let logEmpty = true;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function setStatus(
  text: string,
  cls: "status-connected" | "status-disconnected" | "status-error",
): void {
  statusIndicator.textContent = text;
  statusIndicator.className = cls;
}

function showError(msg: string): void {
  errorBanner.textContent = msg;
  errorBanner.classList.add("visible");
}

function clearError(): void {
  errorBanner.textContent = "";
  errorBanner.classList.remove("visible");
}

function nowLabel(): string {
  const d = new Date();
  const hh = String(d.getHours()).padStart(2, "0");
  const mm = String(d.getMinutes()).padStart(2, "0");
  const ss = String(d.getSeconds()).padStart(2, "0");
  const ms = String(d.getMilliseconds()).padStart(3, "0");
  return `${hh}:${mm}:${ss}.${ms}`;
}

function toHex(chunk: Uint8Array): string {
  return Array.from(chunk)
    .map((b) => b.toString(16).padStart(2, "0").toUpperCase())
    .join(" ");
}

/** Append a line to the hex log and auto-scroll to the bottom. */
function appendLog(chunk: Uint8Array): void {
  if (logEmpty) {
    logDiv.innerHTML = "";
    logEmpty = false;
  }

  const ts = nowLabel();
  const hex = toHex(chunk);

  const line = document.createElement("div");
  line.className = "log-line";
  line.innerHTML = `<span class="ts">[${ts}]</span> ${hex}`;
  logDiv.appendChild(line);

  // Keep the log from growing unbounded — trim to the last 2000 lines.
  if (logDiv.childElementCount > 2000) {
    const keep = Array.from(logDiv.children).slice(-2000);
    logDiv.replaceChildren(...keep);
  }

  logDiv.scrollTop = logDiv.scrollHeight;
}

function onChunk(chunk: Uint8Array): void {
  if (chunk.length === 0) {
    // Zero-length chunk signals device disconnect from inside the read loop.
    handleDisconnect("device disconnected");
    return;
  }

  totalBytes += chunk.length;
  chunkCount++;

  byteCounter.textContent = String(totalBytes);
  lastTs.textContent = nowLabel();
  logCount.textContent = `${chunkCount} chunk${chunkCount === 1 ? "" : "s"}`;

  appendLog(chunk);
}

async function handleDisconnect(reason: string): Promise<void> {
  setStatus(reason, "status-error");
  showError(`Port closed: ${reason}. Unplug and replug the device, then click Connect again.`);
  btnConnect.disabled = false;
  btnDisconnect.disabled = true;

  if (transport) {
    await transport.close().catch(() => undefined);
    transport = null;
  }
}

// ---------------------------------------------------------------------------
// Button handlers
// ---------------------------------------------------------------------------

/**
 * Connect handler — must be called synchronously from the click event so
 * requestPort() executes inside a user-gesture context (SecurityError otherwise).
 */
btnConnect.addEventListener("click", async () => {
  clearError();

  if (transport) {
    return; // Already connected.
  }

  // Check for Web Serial support before attempting anything.
  if (!("serial" in navigator)) {
    showError(
      "Web Serial API is not available. " +
        "Open this page in desktop Chrome or Edge, and make sure it is served over HTTPS " +
        "(or localhost). Other browsers and non-secure contexts do not support Web Serial.",
    );
    return;
  }

  btnConnect.disabled = true;

  try {
    transport = new WebSerialTransport();
    transport.subscribe(onChunk);

    // open() must be called here, synchronously after the click event, so that
    // requestPort() fires while the user-gesture activation is still valid.
    await transport.open();

    setStatus("connected", "status-connected");
    btnDisconnect.disabled = false;
  } catch (err) {
    transport = null;
    btnConnect.disabled = false;

    // The user dismissed the picker — not a real error.
    if (err instanceof DOMException && err.name === "NotFoundError") {
      return;
    }

    const msg = err instanceof Error ? err.message : String(err);
    showError(`Failed to open port: ${msg}`);
    setStatus("error", "status-error");
  }
});

btnDisconnect.addEventListener("click", async () => {
  if (!transport) {
    return;
  }

  btnDisconnect.disabled = true;

  const t = transport;
  transport = null;
  await t.close().catch(() => undefined);

  setStatus("disconnected", "status-disconnected");
  btnConnect.disabled = false;
});
