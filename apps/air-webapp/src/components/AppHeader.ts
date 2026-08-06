import "./AppHeader.css";
import { createStatusPill, type PillTone } from "./StatusPill.js";

export interface AppHeaderHandle {
  el: HTMLElement;
  setConnected(connected: boolean): void;
}

/** Top bar: title dot + "Drone Link" plus a CONNECTED/DISCONNECTED badge. */
export function createAppHeader(): AppHeaderHandle {
  const el = document.createElement("header");
  el.className = "dl-header";

  const titleWrap = document.createElement("h1");
  titleWrap.className = "dl-header__title";

  const dot = document.createElement("span");
  dot.className = "dl-header__title-dot";

  const label = document.createElement("span");
  label.textContent = "Drone Link";

  titleWrap.append(dot, label);

  const pill = createStatusPill({ label: "DISCONNECTED", tone: "neutral", variant: "badge" });

  el.append(titleWrap, pill);

  return {
    el,
    setConnected(connected: boolean) {
      dot.classList.toggle("dl-header__title-dot--connected", connected);
      const tone: PillTone = connected ? "green" : "neutral";
      pill.className = `dl-pill dl-pill--tone-${tone} dl-pill--variant-badge`;
      const textEl = pill.querySelector("span:last-child");
      if (textEl) {
        textEl.textContent = connected ? "CONNECTED" : "DISCONNECTED";
      }
    },
  };
}
