/** Injected time source, so every timer in the flight-control GUI logic runs under fake timers in tests. */
export interface GuiClock {
  /** Wall-clock milliseconds (also used for fc-command `sentAt`). */
  now(): number;
  setInterval(callback: () => void, ms: number): unknown;
  clearInterval(handle: unknown): void;
}

export const systemGuiClock: GuiClock = {
  now: () => Date.now(),
  setInterval: (callback, ms) => globalThis.setInterval(callback, ms),
  clearInterval: (handle) => globalThis.clearInterval(handle as ReturnType<typeof globalThis.setInterval>),
};
