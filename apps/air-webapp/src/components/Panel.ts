import "./Panel.css";

export interface PanelToggleOptions {
  icon: string;
  ariaLabel: string;
  active: boolean;
  onClick: () => void;
}

export interface PanelOptions {
  number: string;
  title: string;
  toggle?: PanelToggleOptions;
}

export interface PanelHandle {
  el: HTMLElement;
  bodyEl: HTMLElement;
  setToggleActive(active: boolean): void;
  setTitle(title: string): void;
}

/** Bordered card with a numbered "[0N] TITLE" header, matching the HUD panel chrome. */
export function createPanel(options: PanelOptions): PanelHandle {
  const el = document.createElement("section");
  el.className = "dl-panel";

  const header = document.createElement("div");
  header.className = "dl-panel__header";

  const title = document.createElement("h2");
  title.className = "dl-panel__title";

  const numberEl = document.createElement("span");
  numberEl.className = "dl-panel__title-number";
  numberEl.textContent = `[${options.number}]`;

  const titleTextEl = document.createElement("span");
  titleTextEl.textContent = options.title;

  title.append(numberEl, titleTextEl);
  header.appendChild(title);

  let toggleBtn: HTMLButtonElement | null = null;
  if (options.toggle) {
    const { icon, ariaLabel, active, onClick } = options.toggle;
    toggleBtn = document.createElement("button");
    toggleBtn.type = "button";
    toggleBtn.className = "dl-panel__toggle" + (active ? " dl-panel__toggle--active" : "");
    toggleBtn.innerHTML = icon;
    toggleBtn.setAttribute("aria-label", ariaLabel);
    toggleBtn.setAttribute("aria-pressed", String(active));
    toggleBtn.addEventListener("click", onClick);
    header.appendChild(toggleBtn);
  }

  el.appendChild(header);

  const bodyEl = document.createElement("div");
  bodyEl.className = "dl-panel__body";
  el.appendChild(bodyEl);

  return {
    el,
    bodyEl,
    setToggleActive(active: boolean) {
      if (!toggleBtn) return;
      toggleBtn.classList.toggle("dl-panel__toggle--active", active);
      toggleBtn.setAttribute("aria-pressed", String(active));
    },
    setTitle(title: string) {
      titleTextEl.textContent = title;
    },
  };
}
