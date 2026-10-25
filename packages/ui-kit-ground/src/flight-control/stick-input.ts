export type StickAxis = "roll" | "pitch" | "yaw" | "throttle";
export const STICK_AXES: readonly StickAxis[] = ["roll", "pitch", "yaw", "throttle"];

export type StickValues = Record<StickAxis, number>;

/**
 * Keyboard layout from issue #88. Positive pitch is forward (stick up), positive roll is
 * right, positive yaw is clockwise, positive throttle is climb.
 */
export const KEY_BINDINGS: Readonly<Record<string, readonly [StickAxis, 1 | -1]>> = {
  KeyW: ["pitch", 1],
  ArrowUp: ["pitch", 1],
  KeyS: ["pitch", -1],
  ArrowDown: ["pitch", -1],
  KeyA: ["roll", -1],
  ArrowLeft: ["roll", -1],
  KeyD: ["roll", 1],
  ArrowRight: ["roll", 1],
  KeyQ: ["yaw", -1],
  KeyE: ["yaw", 1],
  KeyR: ["throttle", 1],
  KeyF: ["throttle", -1],
};

export const DEFAULT_DEFLECTION = 0.5;

function clampUnit(value: number): number {
  return Math.min(1, Math.max(-1, value));
}

function zero(): StickValues {
  return { roll: 0, pitch: 0, yaw: 0, throttle: 0 };
}

/**
 * Combines held keys and on-screen pads into four stick values in [-1, 1], scaled by a per-axis
 * deflection fraction. Holding several keys combines axes; opposite keys on one axis cancel.
 * OS key repeat is ignored: a key counts as held from keydown to keyup, nothing more.
 */
export class StickInput {
  private readonly keys = new Set<string>();
  private readonly pads = new Map<string, Partial<StickValues>>();
  private readonly deflection: StickValues = {
    roll: DEFAULT_DEFLECTION,
    pitch: DEFAULT_DEFLECTION,
    yaw: DEFAULT_DEFLECTION,
    throttle: DEFAULT_DEFLECTION,
  };

  /** Whether `code` is a stick key (so the caller can preventDefault it). */
  static isStickKey(code: string): boolean {
    return code in KEY_BINDINGS;
  }

  keyDown(code: string): boolean {
    if (!StickInput.isStickKey(code)) return false;
    this.keys.add(code);
    return true;
  }

  keyUp(code: string): boolean {
    return this.keys.delete(code);
  }

  /** An on-screen control's contribution, e.g. a D-pad direction held by touch. null removes it. */
  setPad(id: string, values: Partial<StickValues> | null): void {
    if (values === null) this.pads.delete(id);
    else this.pads.set(id, values);
  }

  /** Releases every key and pad (focus loss, dead-man). */
  clear(): void {
    this.keys.clear();
    this.pads.clear();
  }

  setDeflection(axis: StickAxis, fraction: number): void {
    this.deflection[axis] = Math.min(1, Math.max(0, Number.isFinite(fraction) ? fraction : 0));
  }

  getDeflection(axis: StickAxis): number {
    return this.deflection[axis];
  }

  /** True while any key or pad is held. */
  get active(): boolean {
    return this.keys.size > 0 || this.pads.size > 0;
  }

  values(): StickValues {
    const raw = zero();
    for (const code of this.keys) {
      const [axis, sign] = KEY_BINDINGS[code];
      raw[axis] += sign;
    }
    for (const pad of this.pads.values()) {
      for (const axis of STICK_AXES) raw[axis] += pad[axis] ?? 0;
    }
    const out = zero();
    for (const axis of STICK_AXES) out[axis] = clampUnit(raw[axis]) * this.deflection[axis];
    return out;
  }
}
