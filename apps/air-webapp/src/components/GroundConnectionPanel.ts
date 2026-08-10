import "./GroundConnectionPanel.css";
import { createPanel } from "./Panel.js";
import { createStatRow, type StatRowHandle } from "./StatRow.js";
import { icons } from "./icons.js";

export type GroundConnectionMode = "view" | "binding";
export type BindingTab = "paste" | "scan";

export interface GroundConnectionPanelOptions {
  qrSupported: boolean;
  onPair: (bundleText: string) => void;
  onStartScan: () => void;
  onCancelScan: () => void;
}

export interface GroundConnectionPanelHandle {
  el: HTMLElement;
  setMode(mode: GroundConnectionMode): void;
  setConnected(connected: boolean): void;
  setPairing(pairing: boolean): void;
  setLatency(text: string): void;
  setThroughput(text: string): void;
  setUptime(text: string): void;
  setError(message: string): void;
}

/**
 * Ground connection panel. "View" mode shows live WebRTC link stats;
 * "binding" mode lets the operator paste the pairing bundle JSON printed by
 * the ground station, or scan its QR code — the header toggle switches
 * between the two, matching the video/FC panels' pattern.
 */
export function createGroundConnectionPanel(
  options: GroundConnectionPanelOptions,
): GroundConnectionPanelHandle {
  let mode: GroundConnectionMode = "binding";
  let tab: BindingTab = "paste";

  const panel = createPanel({
    number: "03",
    title: "SERVER BINDING",
    toggle: {
      icon: icons.dot,
      ariaLabel: "Toggle ground connection details",
      active: true,
      onClick: () => setMode(mode === "binding" ? "view" : "binding"),
    },
  });

  // --- view mode ---

  const statusRow = document.createElement("div");
  statusRow.className = "dl-ground__row";
  statusRow.innerHTML = `
    <span class="dl-ground__row-left">
      <span class="dl-ground__row-icon">${icons.wifiBars}</span>
      <span>WebRTC Protocol</span>
    </span>
  `;
  const signalIcon = document.createElement("span");
  signalIcon.className = "dl-ground__signal";
  signalIcon.innerHTML = icons.wifiBars;
  statusRow.appendChild(signalIcon);

  const latencyRow: StatRowHandle = createStatRow("Network Latency", "—");
  const throughputRow: StatRowHandle = createStatRow("Relay Throughput", "—");
  const uptimeRow: StatRowHandle = createStatRow("Uptime Session", "00:00:00");

  // --- binding mode ---

  const tabs = document.createElement("div");
  tabs.className = "dl-ground__tabs";

  const pasteTabBtn = document.createElement("button");
  pasteTabBtn.type = "button";
  pasteTabBtn.className = "dl-ground__tab";
  pasteTabBtn.innerHTML = `${icons.keyboard}<span>Paste Bundle</span>`;
  pasteTabBtn.addEventListener("click", () => setTab("paste"));
  tabs.appendChild(pasteTabBtn);

  let scanTabBtn: HTMLButtonElement | null = null;
  if (options.qrSupported) {
    scanTabBtn = document.createElement("button");
    scanTabBtn.type = "button";
    scanTabBtn.className = "dl-ground__tab";
    scanTabBtn.innerHTML = `${icons.qrCode}<span>Scan QR Code</span>`;
    scanTabBtn.addEventListener("click", () => setTab("scan"));
    tabs.appendChild(scanTabBtn);
  }

  const bundleInput = document.createElement("textarea");
  bundleInput.className = "dl-ground__bundle-input";
  bundleInput.rows = 5;
  bundleInput.placeholder =
    '{"sessionId":"...","token":"...","host":"localhost","port":8443,"certFingerprint":"AA:BB:..."}';

  const pairButton = document.createElement("button");
  pairButton.type = "button";
  pairButton.className = "dl-ground__pair-button";
  pairButton.textContent = "Pair";
  pairButton.addEventListener("click", () => options.onPair(bundleInput.value));

  const helper = document.createElement("p");
  helper.className = "dl-ground__helper";

  const errorEl = document.createElement("p");
  errorEl.className = "dl-ground__error";
  errorEl.hidden = true;

  panel.bodyEl.append(
    statusRow,
    latencyRow.el,
    throughputRow.el,
    uptimeRow.el,
    tabs,
    bundleInput,
    pairButton,
    helper,
    errorEl,
  );

  function renderTab() {
    const scanning = tab === "scan";
    bundleInput.hidden = scanning;
    pairButton.hidden = scanning;
    pasteTabBtn.classList.toggle("dl-ground__tab--active", !scanning);
    scanTabBtn?.classList.toggle("dl-ground__tab--active", scanning);
    helper.textContent = scanning
      ? "Point the camera at the ground station's QR code — see the video feed panel above."
      : "Paste the pairing bundle JSON printed by the ground station.";
  }

  function setTab(next: BindingTab) {
    if (tab === next) return;
    const wasScanning = tab === "scan";
    tab = next;
    renderTab();
    if (next === "scan") {
      options.onStartScan();
    } else if (wasScanning) {
      options.onCancelScan();
    }
  }

  function render() {
    const showView = mode === "view";
    statusRow.hidden = !showView;
    latencyRow.el.hidden = !showView;
    throughputRow.el.hidden = !showView;
    uptimeRow.el.hidden = !showView;
    tabs.hidden = showView;
    errorEl.style.display = "";
    if (showView) {
      bundleInput.hidden = true;
      pairButton.hidden = true;
      helper.hidden = true;
    } else {
      renderTab();
      helper.hidden = false;
    }
    panel.setTitle(showView ? "GROUND CONNECTION" : "SERVER BINDING");
    panel.setToggleActive(!showView);
  }

  function setMode(next: GroundConnectionMode) {
    if (mode === "binding" && next === "view" && tab === "scan") {
      options.onCancelScan();
      tab = "paste";
    }
    mode = next;
    render();
  }

  render();

  return {
    el: panel.el,
    setMode,
    setConnected(connected: boolean) {
      signalIcon.classList.toggle("dl-ground__signal--active", connected);
      if (connected) {
        setMode("view");
      }
    },
    setPairing(pairing: boolean) {
      pairButton.disabled = pairing;
      pairButton.textContent = pairing ? "Pairing…" : "Pair";
    },
    setLatency(text: string) {
      latencyRow.setValue(text);
    },
    setThroughput(text: string) {
      throughputRow.setValue(text);
    },
    setUptime(text: string) {
      uptimeRow.setValue(text);
    },
    setError(message: string) {
      errorEl.hidden = message.length === 0;
      errorEl.textContent = message;
    },
  };
}
