import "./Dropdown.css";
import { icons } from "./icons.js";

export interface DropdownOption {
  value: string;
  label: string;
}

export interface DropdownOptions {
  icon?: string;
  onChange: (value: string) => void;
}

export interface DropdownHandle {
  el: HTMLElement;
  setOptions(options: DropdownOption[]): void;
  setValue(value: string): void;
  getValue(): string;
}

/**
 * Custom listbox-style dropdown standing in for a native <select>. Native
 * <option> popups render as a separate UA surface that ignores our theme's
 * background, so we own the option list ourselves. The list is portaled to
 * document.body (fixed-positioned against the trigger) rather than nested
 * under the trigger, since ancestor panels use `overflow: hidden` for their
 * rounded corners and would clip an absolutely-positioned child.
 */
export function createDropdown(options: DropdownOptions): DropdownHandle {
  let items: DropdownOption[] = [];
  let value = "";
  let open = false;

  const el = document.createElement("div");
  el.className = "dl-dropdown";

  const trigger = document.createElement("button");
  trigger.type = "button";
  trigger.className = "dl-dropdown__trigger";
  trigger.setAttribute("aria-haspopup", "listbox");
  trigger.setAttribute("aria-expanded", "false");

  if (options.icon) {
    const iconEl = document.createElement("span");
    iconEl.className = "dl-dropdown__icon";
    iconEl.innerHTML = options.icon;
    trigger.appendChild(iconEl);
  }

  const label = document.createElement("span");
  label.className = "dl-dropdown__label";
  trigger.appendChild(label);

  const chevron = document.createElement("span");
  chevron.className = "dl-dropdown__chevron";
  chevron.innerHTML = icons.chevronDown;
  trigger.appendChild(chevron);

  el.appendChild(trigger);

  const list = document.createElement("ul");
  list.className = "dl-dropdown__list";
  list.setAttribute("role", "listbox");
  list.hidden = true;
  document.body.appendChild(list);

  function close() {
    if (!open) return;
    open = false;
    list.hidden = true;
    trigger.setAttribute("aria-expanded", "false");
    chevron.classList.remove("dl-dropdown__chevron--open");
    document.removeEventListener("pointerdown", handleOutsidePointerDown, true);
    document.removeEventListener("keydown", handleKeyDown, true);
  }

  function handleOutsidePointerDown(event: PointerEvent) {
    const target = event.target as Node | null;
    if (target && (el.contains(target) || list.contains(target))) return;
    close();
  }

  function handleKeyDown(event: KeyboardEvent) {
    if (event.key === "Escape") {
      close();
      trigger.focus();
    }
  }

  function openList() {
    if (open || items.length === 0) return;
    open = true;
    const rect = trigger.getBoundingClientRect();
    list.style.left = `${rect.left}px`;
    list.style.top = `${rect.bottom + 4}px`;
    list.style.width = `${rect.width}px`;
    list.hidden = false;
    trigger.setAttribute("aria-expanded", "true");
    chevron.classList.add("dl-dropdown__chevron--open");
    document.addEventListener("pointerdown", handleOutsidePointerDown, true);
    document.addEventListener("keydown", handleKeyDown, true);
  }

  trigger.addEventListener("click", () => {
    if (open) {
      close();
    } else {
      openList();
    }
  });

  function applySelection() {
    const selected = items.find((item) => item.value === value);
    label.textContent = selected ? selected.label : "";
    list.querySelectorAll<HTMLLIElement>(".dl-dropdown__option").forEach((optionEl) => {
      const isSelected = optionEl.dataset.value === value;
      optionEl.classList.toggle("dl-dropdown__option--selected", isSelected);
      optionEl.setAttribute("aria-selected", String(isSelected));
    });
  }

  function renderOptions() {
    list.replaceChildren();
    items.forEach((item) => {
      const optionEl = document.createElement("li");
      optionEl.className = "dl-dropdown__option";
      optionEl.setAttribute("role", "option");
      optionEl.dataset.value = item.value;
      optionEl.textContent = item.label;
      optionEl.addEventListener("click", () => {
        value = item.value;
        applySelection();
        close();
        options.onChange(item.value);
      });
      list.appendChild(optionEl);
    });
  }

  return {
    el,
    setOptions(next: DropdownOption[]) {
      items = next;
      if (!items.some((item) => item.value === value)) {
        value = items[0]?.value ?? "";
      }
      renderOptions();
      applySelection();
    },
    setValue(next: string) {
      value = items.some((item) => item.value === next) ? next : (items[0]?.value ?? "");
      applySelection();
    },
    getValue() {
      return value;
    },
  };
}
