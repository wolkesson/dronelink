import { afterEach, describe, expect, it, vi } from "vitest";
import { startBatteryMonitor } from "./BatteryMonitor.js";

function makeBattery(level: number, charging: boolean) {
  const listeners = new Map<string, () => void>();
  return {
    level,
    charging,
    addEventListener: vi.fn((type: string, fn: () => void) => listeners.set(type, fn)),
    removeEventListener: vi.fn((type: string) => listeners.delete(type)),
    fire(type: string) {
      listeners.get(type)?.();
    },
  };
}

async function flush(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("startBatteryMonitor", () => {
  it("reports the current reading as a rounded percent, then again on change", async () => {
    const battery = makeBattery(0.774, false);
    vi.stubGlobal("navigator", { getBattery: () => Promise.resolve(battery) });
    const onChange = vi.fn();

    startBatteryMonitor(onChange);
    await flush();
    expect(onChange).toHaveBeenLastCalledWith({ percent: 77, charging: false });

    battery.level = 0.5;
    battery.fire("levelchange");
    expect(onChange).toHaveBeenLastCalledWith({ percent: 50, charging: false });

    battery.charging = true;
    battery.fire("chargingchange");
    expect(onChange).toHaveBeenLastCalledWith({ percent: 50, charging: true });
  });

  it("never reports where the Battery Status API is unavailable", () => {
    vi.stubGlobal("navigator", {});
    const onChange = vi.fn();
    const monitor = startBatteryMonitor(onChange);
    expect(() => monitor.stop()).not.toThrow();
    expect(onChange).not.toHaveBeenCalled();
  });

  it("tolerates getBattery() rejecting", async () => {
    vi.stubGlobal("navigator", { getBattery: () => Promise.reject(new Error("denied")) });
    const onChange = vi.fn();
    startBatteryMonitor(onChange);
    await flush();
    expect(onChange).not.toHaveBeenCalled();
  });

  it("stop() removes the listeners and silences later events", async () => {
    const battery = makeBattery(0.9, true);
    vi.stubGlobal("navigator", { getBattery: () => Promise.resolve(battery) });
    const onChange = vi.fn();

    const monitor = startBatteryMonitor(onChange);
    await flush();
    monitor.stop();
    onChange.mockClear();

    battery.fire("levelchange");
    expect(battery.removeEventListener).toHaveBeenCalledTimes(2);
    expect(onChange).not.toHaveBeenCalled();
  });
});
