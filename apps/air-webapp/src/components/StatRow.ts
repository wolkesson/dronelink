import "./StatRow.css";

export interface StatRowHandle {
  el: HTMLElement;
  setValue(value: string, tone?: "default" | "green"): void;
}

/** A single "Label ..... value" line used inside panel bodies. */
export function createStatRow(label: string, initialValue: string): StatRowHandle {
  const el = document.createElement("div");
  el.className = "dl-stat-row";

  const labelEl = document.createElement("span");
  labelEl.className = "dl-stat-row__label";
  labelEl.textContent = label;

  const valueEl = document.createElement("span");
  valueEl.className = "dl-stat-row__value";
  valueEl.textContent = initialValue;

  el.append(labelEl, valueEl);

  return {
    el,
    setValue(value: string, tone: "default" | "green" = "default") {
      valueEl.textContent = value;
      valueEl.classList.toggle("dl-stat-row__value--tone-green", tone === "green");
    },
  };
}
