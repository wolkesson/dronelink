import "./FlightControlPanel.css";
import type { FlightControlController } from "@dronelink/air-client-sdk";
import { createPanel } from "./Panel.js";
import { createStatRow } from "./StatRow.js";

type FlightControlState = ReturnType<FlightControlController["buildState"]>;

export interface FlightControlPanelOptions {
  onEnabledChange: (enabled: boolean) => void;
}

export interface FlightControlPanelHandle {
  el: HTMLElement;
  render(state: FlightControlState): void;
}

const LINK_MODE_TEXT = { transparent: "Transparent", pending: "Identifying…", verified: "Verified" } as const;

/**
 * Flight control (ARCHITECTURE.md section 7): the opt-in setting and the read-only state the
 * air reports to the ground, so the phone shows why the link is or isn't under control.
 */
export function createFlightControlPanel(options: FlightControlPanelOptions): FlightControlPanelHandle {
  const panel = createPanel({ number: "03", title: "FLIGHT CONTROL" });

  const toggle = document.createElement("label");
  toggle.className = "dl-fcp__toggle";
  const checkbox = document.createElement("input");
  checkbox.type = "checkbox";
  checkbox.addEventListener("change", () => options.onEnabledChange(checkbox.checked));
  const toggleText = document.createElement("span");
  toggleText.textContent = "Allow flight control from the ground";
  toggle.append(checkbox, toggleText);

  const helper = document.createElement("p");
  helper.className = "dl-fcp__helper";
  helper.textContent = "Off: the serial link stays a transparent relay. On: a supported Betaflight FC is identified and can be handed over by the safety pilot.";

  const linkTypeRow = createStatRow("Link type", "—");
  const linkRow = createStatRow("Link", "—");
  const fcRow = createStatRow("FC", "—");
  const supervisorRow = createStatRow("Supervisor", "—");

  panel.bodyEl.append(toggle, helper, linkTypeRow.el, linkRow.el, fcRow.el, supervisorRow.el);

  return {
    el: panel.el,
    render(state) {
      checkbox.checked = state.flightControlEnabled;
      linkTypeRow.setValue(state.link.detectedType);
      const reason = state.link.reason ? ` (${state.link.reason})` : "";
      linkRow.setValue(`${LINK_MODE_TEXT[state.link.mode]}${reason}`, state.link.mode === "verified" ? "green" : "default");
      fcRow.setValue(state.fc ? `${state.fc.variant} ${state.fc.version} · ${state.fc.board}` : "—");
      const supervisorReason = state.supervisor.reason ? ` (${state.supervisor.reason})` : "";
      supervisorRow.setValue(
        `${state.supervisor.state}${supervisorReason}`,
        state.supervisor.state === "ACTIVE" || state.supervisor.state === "NEUTRAL" ? "green" : "default",
      );
    },
  };
}
