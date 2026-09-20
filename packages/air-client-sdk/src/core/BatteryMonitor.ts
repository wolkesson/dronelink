/** Air-unit battery reading, as sent to the ground in an air-status message. */
export interface BatteryStatus {
  percent: number;
  charging: boolean;
}

interface BatteryManagerLike {
  level: number;
  charging: boolean;
  addEventListener(type: string, listener: () => void): void;
  removeEventListener(type: string, listener: () => void): void;
}

export interface BatteryMonitor {
  stop(): void;
}

/**
 * Watches the device battery via the Battery Status API and calls onChange with
 * the current reading immediately and on every level/charging change. Does
 * nothing (never calls onChange) where the API is unavailable, so callers can
 * treat "no report" as "unknown".
 */
export function startBatteryMonitor(onChange: (status: BatteryStatus) => void): BatteryMonitor {
  const nav = globalThis.navigator as (Navigator & { getBattery?: () => Promise<BatteryManagerLike> }) | undefined;
  if (typeof nav?.getBattery !== "function") {
    return { stop() {} };
  }

  let battery: BatteryManagerLike | null = null;
  let stopped = false;

  const emit = (): void => {
    if (!battery || stopped) return;
    const percent = Math.min(100, Math.max(0, Math.round(battery.level * 100)));
    onChange({ percent, charging: battery.charging });
  };

  nav.getBattery().then(
    (b) => {
      if (stopped) return;
      battery = b;
      b.addEventListener("levelchange", emit);
      b.addEventListener("chargingchange", emit);
      emit();
    },
    () => undefined,
  );

  return {
    stop() {
      stopped = true;
      battery?.removeEventListener("levelchange", emit);
      battery?.removeEventListener("chargingchange", emit);
    },
  };
}
