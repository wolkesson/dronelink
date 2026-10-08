import "./FlightControllerPanel.css";
import { createPanel } from "./Panel.js";
import { createStatusPill } from "./StatusPill.js";
import { createStatRow, type StatRowHandle } from "./StatRow.js";
import { icons } from "./icons.js";

export interface FlightControllerPanelOptions {
  onConnectRequest: () => void;
}

export interface FlightControllerPanelHandle {
  el: HTMLElement;
  setConnected(connected: boolean, label?: string): void;
  setConnecting(connecting: boolean): void;
  setBaudRate(text: string): void;
  setTxRate(text: string, active: boolean): void;
  setRxRate(text: string, active: boolean): void;
  setError(message: string): void;
}

/**
 * Flight controller link panel. Shows a "connect a device" row until the
 * WebSerial picker grants a port, then switches to a live status view with
 * baud rate and TX/RX byte-rate stats sourced from LinkActivityTracker.
 */
export function createFlightControllerPanel(
  options: FlightControllerPanelOptions,
): FlightControllerPanelHandle {
  const panel = createPanel({ number: "02", title: "FLIGHT CONTROLLER LINK" });

  // --- select / connect row ---

  const connectRow = document.createElement("button");
  connectRow.type = "button";
  connectRow.className = "dl-fc__row";
  connectRow.innerHTML = `
    <span class="dl-fc__row-left">
      <span class="dl-fc__row-icon">${icons.usb}</span>
      <span class="dl-fc__row-label">Select a flight controller…</span>
    </span>
    <span class="dl-fc__row-icon">${icons.chevronDown}</span>
  `;
  connectRow.addEventListener("click", () => options.onConnectRequest());

  const helper = document.createElement("p");
  helper.className = "dl-fc__helper";
  helper.textContent = "Choose a connection to the Flight Controller.";

  const errorEl = document.createElement("p");
  errorEl.className = "dl-fc__error";
  errorEl.hidden = true;

  // --- connected / status view ---

  const statusRow = document.createElement("div");
  statusRow.className = "dl-fc__status-row";

  const statusLeft = document.createElement("span");
  statusLeft.className = "dl-fc__status-left";
  const statusIcon = document.createElement("span");
  statusIcon.className = "dl-fc__status-icon";
  statusIcon.innerHTML = icons.usb;
  const statusLabel = document.createElement("span");
  statusLabel.textContent = "USB Serial";
  statusLeft.append(statusIcon, statusLabel);

  const activePill = createStatusPill({ label: "ACTIVE", tone: "green", variant: "inline" });
  statusRow.append(statusLeft, activePill);

  const baudRow: StatRowHandle = createStatRow("Baud Rate", "—");
  const txRow: StatRowHandle = createStatRow("TX Rate", "0 B/s");
  const rxRow: StatRowHandle = createStatRow("RX Rate", "0 B/s");

  panel.bodyEl.append(connectRow, helper, errorEl, statusRow, baudRow.el, txRow.el, rxRow.el);

  function render(connected: boolean) {
    connectRow.hidden = connected;
    helper.hidden = connected;
    statusRow.hidden = !connected;
    baudRow.el.hidden = !connected;
    txRow.el.hidden = !connected;
    rxRow.el.hidden = !connected;
  }

  render(false);

  return {
    el: panel.el,
    setConnected(connected: boolean, label = "USB Serial") {
      statusLabel.textContent = label;
      render(connected);
    },
    setConnecting(connecting: boolean) {
      connectRow.disabled = connecting;
      const labelEl = connectRow.querySelector<HTMLElement>(".dl-fc__row-label");
      if (labelEl) {
        labelEl.textContent = connecting
          ? "Waiting for port selection…"
          : "Select a flight controller…";
      }
    },
    setBaudRate(text: string) {
      baudRow.setValue(text);
    },
    setTxRate(text: string, active: boolean) {
      txRow.setValue(text, active ? "green" : "default");
    },
    setRxRate(text: string, active: boolean) {
      rxRow.setValue(text, active ? "green" : "default");
    },
    setError(message: string) {
      errorEl.hidden = message.length === 0;
      errorEl.textContent = message;
    },
  };
}
