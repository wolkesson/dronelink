import "./StatusPill.css";

export type PillTone = "green" | "red" | "neutral";
export type PillVariant = "badge" | "inline" | "solid";

export interface StatusPillOptions {
  label: string;
  tone?: PillTone;
  variant?: PillVariant;
  withDot?: boolean;
}

/** Small status indicator: a dot + label, either inline text, an outlined badge, or a solid chip. */
export function createStatusPill(options: StatusPillOptions): HTMLElement {
  const { label, tone = "green", variant = "inline", withDot = true } = options;

  const el = document.createElement("span");
  el.className = `dl-pill dl-pill--tone-${tone} dl-pill--variant-${variant}`;

  if (withDot) {
    const dot = document.createElement("span");
    dot.className = "dl-pill__dot";
    el.appendChild(dot);
  }

  const text = document.createElement("span");
  text.textContent = label;
  el.appendChild(text);

  return el;
}

export function updateStatusPillLabel(el: HTMLElement, label: string): void {
  const textEl = el.querySelector("span:last-child");
  if (textEl) {
    textEl.textContent = label;
  }
}
