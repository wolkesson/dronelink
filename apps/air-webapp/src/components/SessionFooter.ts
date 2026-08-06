import "./SessionFooter.css";

export interface SessionFooterHandle {
  el: HTMLElement;
  setState(text: string): void;
}

/** Small centered caption under the disconnect button, e.g. session/encryption state. */
export function createSessionFooter(initialText: string): SessionFooterHandle {
  const el = document.createElement("p");
  el.className = "dl-footer";
  el.textContent = initialText;

  return {
    el,
    setState(text: string) {
      el.textContent = text;
    },
  };
}
