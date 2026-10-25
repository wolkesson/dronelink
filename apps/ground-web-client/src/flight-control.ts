/**
 * Ground GUI flight-control panel (issues #87, #88): DOM composition only. Every decision
 * (what to show, when to stream, unlock, abort, dead-man) lives in @dronelink/ui-kit-ground's
 * FlightControlGui. Bundled by ground-core-node and served as /flight-control.js.
 */
import {
  DEAD_MAN_TEXT,
  FlightControlGui,
  STICK_AXES,
  type FlightControlGuiView,
  type StickAxis,
  type StickValues,
} from "@dronelink/ui-kit-ground";
import type { FlightControlGroundMessage } from "@dronelink/core-transport";
import { FLIGHT_CONTROL_CSS } from "./flight-control-styles.js";

export interface FlightControlPanel {
  /** Feed every GUI signaling message; true when the panel consumed it. */
  handleMessage(message: unknown): boolean;
  setSocketOpen(open: boolean): void;
  setRtt(rttMs: number | null): void;
  dispose(): void;
}

export interface MountOptions {
  send: (message: FlightControlGroundMessage) => void;
}

const AXIS_LABELS: Record<StickAxis, string> = { roll: "Roll", pitch: "Pitch", yaw: "Yaw", throttle: "Climb" };

interface PadSpec {
  id: string;
  label: string;
  key: string;
  values: Partial<StickValues>;
  area: string;
}

const LEFT_PAD: PadSpec[] = [
  { id: "up", label: "▲", key: "R", values: { throttle: 1 }, area: "up" },
  { id: "down", label: "▼", key: "F", values: { throttle: -1 }, area: "down" },
  { id: "left", label: "⟲", key: "Q", values: { yaw: -1 }, area: "left" },
  { id: "right", label: "⟳", key: "E", values: { yaw: 1 }, area: "right" },
];
const RIGHT_PAD: PadSpec[] = [
  { id: "fwd", label: "▲", key: "W", values: { pitch: 1 }, area: "up" },
  { id: "back", label: "▼", key: "S", values: { pitch: -1 }, area: "down" },
  { id: "left", label: "◀", key: "A", values: { roll: -1 }, area: "left" },
  { id: "right", label: "▶", key: "D", values: { roll: 1 }, area: "right" },
];

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className?: string, text?: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function row(label: string): { root: HTMLElement; value: HTMLElement } {
  const root = el("div", "fcp-row");
  const value = el("span", "fcp-row__value", "—");
  root.append(el("span", "fcp-row__label", label), value);
  return { root, value };
}

function ms(value: number | null): string {
  return value === null ? "—" : `${Math.round(value)} ms`;
}

export function mountFlightControl(root: HTMLElement, options: MountOptions): FlightControlPanel {
  if (!document.getElementById("fcp-styles")) {
    const style = el("style");
    style.id = "fcp-styles";
    style.textContent = FLIGHT_CONTROL_CSS;
    document.head.append(style);
  }

  const gui = new FlightControlGui({ send: options.send });
  root.classList.add("fcp");
  root.replaceChildren();

  // --- header, banner, link ---
  const header = el("div", "fcp-header");
  header.append(el("h2", "fcp-title", "Flight control"));
  const staleBadge = el("span", "fcp-stale", "STALE");
  header.append(staleBadge);

  const banner = el("div", "fcp-banner");
  const linkType = row("Link type");
  const linkMode = row("Link");
  const fcIdentity = row("FC");
  const supervisor = row("Supervisor");

  const settingLabel = el("label", "fcp-setting");
  const settingBox = el("input");
  settingBox.type = "checkbox";
  settingLabel.append(settingBox, el("span", undefined, "Flight control enabled on the air unit"));
  const settingHint = el("p", "fcp-hint");
  settingBox.addEventListener("change", () => {
    const wanted = settingBox.checked;
    settingBox.checked = !wanted; // the air's report decides what is shown
    gui.setFlightControlEnabled(wanted);
  });

  const errorLine = el("p", "fcp-error");

  // --- flight UI (only while the setting is on) ---
  const flight = el("div", "fcp-flight");

  const goTitle = el("div", "fcp-go");
  const goList = el("ul", "fcp-go-list");

  const telemetry = el("div", "fcp-telemetry");

  const health = el("div", "fcp-health");
  const rtt = row("Round trip");
  const commandAge = row("Command age at air");
  const stateAge = row("State age");
  health.append(rtt.root, commandAge.root, stateAge.root);

  const controls = el("div", "fcp-controls");
  const takeControl = el("button", "fcp-take");
  takeControl.type = "button";
  takeControl.innerHTML = `<svg viewBox="0 0 44 44" aria-hidden="true"><circle class="fcp-take__track" cx="22" cy="22" r="19"/><circle class="fcp-take__ring" cx="22" cy="22" r="19"/></svg><span>Hold to take control <kbd>Enter</kbd></span>`;
  const ring = takeControl.querySelector<SVGCircleElement>(".fcp-take__ring")!;
  const ringLength = 2 * Math.PI * 19;
  ring.style.strokeDasharray = `${ringLength}`;

  const abortButton = el("button", "fcp-abort", "ABORT");
  abortButton.type = "button";
  abortButton.title = "Space / Esc";
  const handBack = el("button", "fcp-handback", "Hand back to safety pilot");
  handBack.type = "button";
  const deadMan = el("p", "fcp-deadman");
  const actionLine = el("div", "fcp-actions");
  actionLine.append(abortButton, handBack);
  controls.append(takeControl, actionLine, deadMan);

  const pads = el("div", "fcp-pads");
  const padButtons: { button: HTMLButtonElement; spec: PadSpec }[] = [];
  function buildPad(name: string, title: string, specs: PadSpec[]): HTMLElement {
    const wrap = el("div", "fcp-pad");
    wrap.append(el("div", "fcp-pad__title", title));
    const grid = el("div", "fcp-pad__grid");
    for (const spec of specs) {
      const button = el("button", `fcp-pad__btn fcp-pad__btn--${spec.area}`);
      button.type = "button";
      button.innerHTML = `${spec.label}<kbd>${spec.key}</kbd>`;
      const id = `${name}:${spec.id}`;
      const release = () => gui.setPad(id, null);
      button.addEventListener("pointerdown", (event) => {
        event.preventDefault();
        button.setPointerCapture?.(event.pointerId);
        gui.setPad(id, spec.values);
      });
      button.addEventListener("pointerup", release);
      button.addEventListener("pointercancel", release);
      button.addEventListener("lostpointercapture", release);
      button.addEventListener("contextmenu", (event) => event.preventDefault());
      padButtons.push({ button, spec });
      grid.append(button);
    }
    wrap.append(grid);
    return wrap;
  }
  pads.append(buildPad("left", "Climb / yaw", LEFT_PAD), buildPad("right", "Move", RIGHT_PAD));

  const sliders = el("div", "fcp-sliders");
  for (const axis of STICK_AXES) {
    const label = el("label", "fcp-slider");
    const input = el("input");
    input.type = "range";
    input.min = "0";
    input.max = "100";
    input.step = "5";
    input.value = String(Math.round(gui.input.getDeflection(axis) * 100));
    const value = el("span", "fcp-slider__value", `${input.value} %`);
    input.addEventListener("input", () => {
      gui.input.setDeflection(axis, Number(input.value) / 100);
      value.textContent = `${input.value} %`;
    });
    label.append(el("span", undefined, AXIS_LABELS[axis]), input, value);
    sliders.append(label);
  }
  const sliderHint = el("p", "fcp-hint", "Deflection is a fraction of the air unit's limit, which it always enforces.");

  const keys = el("p", "fcp-hint", "Keys: W/S/A/D or arrows move, Q/E yaw, R/F climb/descend, Space/Esc ABORT. Hold Enter to take control.");

  flight.append(
    el("h3", "fcp-subtitle", "Go / no-go"), goTitle, goList,
    el("h3", "fcp-subtitle", "Telemetry"), telemetry,
    el("h3", "fcp-subtitle", "Link health"), health,
    el("h3", "fcp-subtitle", "Control"), controls, pads, sliders, sliderHint, keys,
  );

  root.append(header, banner, linkType.root, linkMode.root, fcIdentity.root, supervisor.root, settingLabel, settingHint, errorLine, flight);

  // --- input wiring ---
  const holdStart = (event: Event) => {
    event.preventDefault();
    gui.pressUnlock();
  };
  const holdEnd = () => gui.releaseUnlock();
  takeControl.addEventListener("pointerdown", (event) => {
    takeControl.setPointerCapture?.(event.pointerId);
    holdStart(event);
  });
  takeControl.addEventListener("pointerup", holdEnd);
  takeControl.addEventListener("pointercancel", holdEnd);
  takeControl.addEventListener("lostpointercapture", holdEnd);
  takeControl.addEventListener("contextmenu", (event) => event.preventDefault());
  abortButton.addEventListener("click", () => gui.abort());
  abortButton.addEventListener("pointerdown", () => gui.abort());
  handBack.addEventListener("click", () => gui.handBack());

  const isTextTarget = (target: EventTarget | null) =>
    target instanceof HTMLElement &&
    (target.tagName === "SELECT" || target.tagName === "TEXTAREA" || (target instanceof HTMLInputElement && !["range", "checkbox"].includes(target.type)));
  const onKeyDown = (event: KeyboardEvent) => {
    if (isTextTarget(event.target)) return;
    if (gui.keyDown(event.code, event.repeat) !== null) event.preventDefault();
  };
  const onKeyUp = (event: KeyboardEvent) => gui.keyUp(event.code);
  const onBlur = () => gui.setWindowFocused(false);
  const onFocus = () => gui.setWindowFocused(true);
  const onVisibility = () => gui.setPageVisible(document.visibilityState === "visible");
  window.addEventListener("keydown", onKeyDown);
  window.addEventListener("keyup", onKeyUp);
  window.addEventListener("blur", onBlur);
  window.addEventListener("focus", onFocus);
  document.addEventListener("visibilitychange", onVisibility);
  gui.setWindowFocused(document.hasFocus());
  onVisibility();

  // --- rendering ---
  function render(view: FlightControlGuiView): void {
    root.classList.toggle("fcp--stale", view.stale && !view.noState);
    // While the PP holds the controls, ABORT is pinned to the bottom of the viewport.
    root.classList.toggle("fcp--unlocked", view.flightControlEnabled && (view.unlocked || view.abortEnabled));
    staleBadge.hidden = !(view.stale && !view.noState);

    banner.hidden = view.banner === null;
    if (view.banner) {
      banner.textContent = view.banner.text;
      banner.dataset.tone = view.banner.tone;
    }
    linkType.value.textContent = view.linkType;
    linkMode.value.textContent = view.linkMode.text;
    linkMode.value.dataset.tone = view.linkMode.tone;
    fcIdentity.value.textContent = view.fcIdentity ?? "—";
    supervisor.value.textContent = view.supervisor.state
      ? `${view.supervisor.state}${view.supervisor.reason ? ` — ${view.supervisor.reason}` : ""}`
      : "—";

    settingBox.checked = view.flightControlEnabled;
    settingBox.disabled = !view.settingChangeAllowed || view.pending.includes("setting");
    settingHint.textContent = view.pending.includes("setting")
      ? "Waiting for the air unit to confirm…"
      : view.settingChangeAllowed || view.noState
        ? ""
        : "Can only be changed while the safety pilot is in control.";
    errorLine.hidden = view.lastError === null;
    errorLine.textContent = view.lastError ?? "";

    flight.hidden = !view.flightControlEnabled;
    if (!view.flightControlEnabled) return;

    goTitle.textContent = view.goNoGo.go ? "GO" : "NO-GO";
    goTitle.dataset.tone = view.goNoGo.go ? "ok" : "danger";
    goList.replaceChildren(
      ...view.goNoGo.items.map((item) => {
        const li = el("li", item.ok ? "fcp-ok" : "fcp-bad", `${item.ok ? "✓" : "✗"} ${item.label}`);
        if (item.detail) li.append(el("span", "fcp-detail", ` (${item.detail})`));
        return li;
      }),
    );

    telemetry.replaceChildren(
      ...view.telemetry.map((entry) => {
        const r = row(entry.label);
        r.value.textContent = entry.value;
        r.value.dataset.tone = entry.tone;
        return r.root;
      }),
    );
    if (view.telemetry.length === 0) telemetry.append(el("p", "fcp-hint", "No FC telemetry (FC not verified or not polled yet)."));

    const rttItem = view.goNoGo.items.find((item) => item.key === "rtt");
    rtt.value.textContent = rttItem?.detail ?? "—";
    rtt.value.dataset.tone = rttItem?.ok ? "ok" : "danger";
    commandAge.value.textContent = view.unlocked ? ms(view.commandAgeMs) : "—";
    stateAge.value.textContent = ms(view.stateAgeMs);
    stateAge.value.dataset.tone = view.stale ? "danger" : "neutral";

    takeControl.hidden = !(view.supervisor.state === "HANDED_OVER" || view.supervisor.state === "ABORTED");
    takeControl.disabled = !view.unlockOffered && view.unlockProgress === 0;
    takeControl.title = view.unlockOffered ? "" : "Not offered: go/no-go is red";
    ring.style.strokeDashoffset = `${ringLength * (1 - view.unlockProgress)}`;
    takeControl.querySelector("span")!.innerHTML = view.pending.includes("unlock")
      ? "Unlocking…"
      : `Hold to take control <kbd>Enter</kbd>`;

    abortButton.disabled = !view.abortEnabled;
    handBack.disabled = !(view.unlocked || view.supervisor.state === "HANDED_OVER");
    const flying = view.supervisor.state === "ACTIVE" || view.supervisor.state === "NEUTRAL";
    for (const { button, spec } of padButtons) {
      button.disabled = !flying;
      // Lights up for keys as well as touches, from the values actually being sent.
      const engaged = view.streaming && STICK_AXES.some((axis) => {
        const want = spec.values[axis];
        return want !== undefined && Math.sign(view.sticks[axis]) === want;
      });
      button.classList.toggle("fcp-pad__btn--engaged", engaged);
    }

    deadMan.hidden = !(view.unlocked && view.deadMan.length > 0);
    deadMan.textContent = `Command stream stopped: ${view.deadMan.map((reason) => DEAD_MAN_TEXT[reason]).join(", ")}. The air unit holds position, then hands back to the safety pilot.`;
    controls.dataset.streaming = String(view.streaming);
  }

  gui.onChange(render);
  render(gui.view);

  return {
    handleMessage: (message) => gui.handleMessage(message),
    setSocketOpen: (open) => gui.setSocketOpen(open),
    setRtt: (rttMs) => gui.setRtt(rttMs),
    dispose() {
      gui.dispose();
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("keyup", onKeyUp);
      window.removeEventListener("blur", onBlur);
      window.removeEventListener("focus", onFocus);
      document.removeEventListener("visibilitychange", onVisibility);
    },
  };
}
