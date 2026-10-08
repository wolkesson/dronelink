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
  toggles?: PanelToggleOptions[];
}

export interface PanelToggleHandle {
  setActive(active: boolean): void;
  setHidden(hidden: boolean): void;
}

export interface PanelHandle {
  el: HTMLElement;
  bodyEl: HTMLElement;
  /** One handle per entry of `options.toggles`, in the same order. */
  toggles: PanelToggleHandle[];
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

  const toggleGroup = document.createElement("div");
  toggleGroup.className = "dl-panel__toggles";

  const toggles: PanelToggleHandle[] = (options.toggles ?? []).map(({ icon, ariaLabel, active, onClick }) => {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "dl-panel__toggle" + (active ? " dl-panel__toggle--active" : "");
    btn.innerHTML = icon;
    btn.setAttribute("aria-label", ariaLabel);
    btn.setAttribute("aria-pressed", String(active));
    btn.addEventListener("click", onClick);
    toggleGroup.appendChild(btn);
    return {
      setActive(next: boolean) {
        btn.classList.toggle("dl-panel__toggle--active", next);
        btn.setAttribute("aria-pressed", String(next));
      },
      setHidden(hidden: boolean) {
        btn.hidden = hidden;
      },
    };
  });
  if (toggles.length > 0) {
    header.appendChild(toggleGroup);
  }

  el.appendChild(header);

  const bodyEl = document.createElement("div");
  bodyEl.className = "dl-panel__body";
  el.appendChild(bodyEl);

  return {
    el,
    bodyEl,
    toggles,
    setTitle(title: string) {
      titleTextEl.textContent = title;
    },
  };
}
