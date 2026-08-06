import "./DisconnectButton.css";
import { icons } from "./icons.js";

export interface DisconnectButtonHandle {
  el: HTMLButtonElement;
}

/** Full-width red "DISCONNECT" action used at the bottom of the panel stack. */
export function createDisconnectButton(onClick: () => void): DisconnectButtonHandle {
  const el = document.createElement("button");
  el.type = "button";
  el.className = "dl-disconnect";
  el.disabled = true;
  el.innerHTML = `${icons.power}<span>Disconnect</span>`;
  el.addEventListener("click", onClick);

  return { el };
}
