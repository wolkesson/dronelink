/**
 * serial-test.ts — entry point for the Phase 0 serial spike test page (serial-test.html).
 *
 * Wires up the Connect / Disconnect buttons to WebSerialTransport and renders:
 *   - a live "bytes received" counter
 *   - a "last byte at HH:MM:SS.mmm" timestamp
 *   - a scrolling hex dump of every received chunk, with MSP response lines labelled
 *
 * Poll behaviour (MSP is request/response, not a push stream):
 *   Every 500ms, this page writes an MSP_API_VERSION request to the FC so it has something
 *   to respond to. Once two consecutive MSP responses have been seen — proving the byte path
 *   works — polling stops automatically to avoid spamming the FC.
 *
 * This file is NOT part of the main app bundle. It is a standalone development
 * harness independent of pairing / WebRTC / protocol parsing.
 */

import { WebSerialTransport } from "@dronelink/air-client-sdk";

// ---------------------------------------------------------------------------
// MSP_API_VERSION request frame (fixed literal — do not compute at runtime).
// Header: $M< | payload length: 0x00 | command: 0x01 | checksum: 0x01
// ---------------------------------------------------------------------------
const MSP_API_VERSION_REQUEST = new Uint8Array([0x24, 0x4d, 0x3c, 0x00, 0x01, 0x01]);

/** Prefix bytes that mark a successful MSP response: "$M>" */
const MSP_RESPONSE_OK = [0x24, 0x4d, 0x3e] as const;

/** Prefix bytes that mark an MSP error response: "$M!" */
const MSP_RESPONSE_ERR = [0x24, 0x4d, 0x21] as const;

/** Number of consecutive MSP responses after which polling stops. */
const POLL_STOP_AFTER = 2;

/** Poll interval in milliseconds. */
const POLL_INTERVAL_MS = 500;

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

/** setInterval handle for the MSP poll; null when polling is inactive. */
let pollTimer: ReturnType<typeof setInterval> | null = null;

/** Number of consecutive MSP response chunks seen so far in the current session. */
let consecutiveResponses = 0;

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

/**
 * Returns true if `chunk` starts with all bytes of `prefix`.
 * Used to detect MSP response/error preambles without full protocol parsing.
 */
function startsWith(chunk: Uint8Array, prefix: readonly number[]): boolean {
  if (chunk.length < prefix.length) return false;
  return prefix.every((b, i) => chunk[i] === b);
}

/** Append a line to the hex log and auto-scroll to the bottom. */
function appendLog(chunk: Uint8Array, label?: string): void {
  if (logEmpty) {
    logDiv.innerHTML = "";
    logEmpty = false;
  }

  const ts = nowLabel();
  const hex = toHex(chunk);
  const suffix = label ? ` <span class="log-label">${label}</span>` : "";

  const line = document.createElement("div");
  line.className = "log-line";
  line.innerHTML = `<span class="ts">[${ts}]</span> ${hex}${suffix}`;
  logDiv.appendChild(line);

  // Keep the log from growing unbounded — trim to the last 2000 lines.
  if (logDiv.childElementCount > 2000) {
    const keep = Array.from(logDiv.children).slice(-2000);
    logDiv.replaceChildren(...keep);
  }

  logDiv.scrollTop = logDiv.scrollHeight;
}

/** Stop the MSP poll timer if it is running. */
function stopPolling(): void {
  if (pollTimer !== null) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
}

/** Start sending MSP_API_VERSION every POLL_INTERVAL_MS until two responses arrive. */
function startPolling(t: WebSerialTransport): void {
  consecutiveResponses = 0;
  pollTimer = setInterval(() => {
    t.write(MSP_API_VERSION_REQUEST).catch((err) => {
      // Write failed (port closed or disconnected) — stop polling silently.
      stopPolling();
      const msg = err instanceof Error ? err.message : String(err);
      appendLog(new Uint8Array(0), `poll error: ${msg}`);
    });
  }, POLL_INTERVAL_MS);
}

function onChunk(chunk: Uint8Array): void {
  if (chunk.length === 0) {
    // Zero-length chunk signals device disconnect from inside the read loop.
    void handleDisconnect("device disconnected");
    return;
  }

  totalBytes += chunk.length;
  chunkCount++;

  byteCounter.textContent = String(totalBytes);
  lastTs.textContent = nowLabel();
  logCount.textContent = `${chunkCount} chunk${chunkCount === 1 ? "" : "s"}`;

  // Detect MSP response preambles to label the log entry and track consecutive responses.
  let label: string | undefined;
  if (startsWith(chunk, MSP_RESPONSE_OK)) {
    label = "← MSP OK";
    consecutiveResponses++;
  } else if (startsWith(chunk, MSP_RESPONSE_ERR)) {
    label = "← MSP ERR (link proven)";
    consecutiveResponses++;
  } else {
    consecutiveResponses = 0;
  }

  appendLog(chunk, label);

  // Two consecutive responses means the byte path is proven — stop polling.
  if (consecutiveResponses >= POLL_STOP_AFTER && pollTimer !== null) {
    stopPolling();
    appendLog(new Uint8Array(0), "polling stopped — byte path confirmed");
  }
}

async function handleDisconnect(reason: string): Promise<void> {
  stopPolling();
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

    setStatus("connected — polling FC…", "status-connected");
    btnDisconnect.disabled = false;

    // Begin the MSP poll now that we have an open port and a persistent writer.
    startPolling(transport);
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

  stopPolling();
  btnDisconnect.disabled = true;

  const t = transport;
  transport = null;
  await t.close().catch(() => undefined);

  setStatus("disconnected", "status-disconnected");
  btnConnect.disabled = false;
});
