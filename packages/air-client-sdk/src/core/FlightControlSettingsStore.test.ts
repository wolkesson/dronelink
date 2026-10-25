import { describe, expect, it, vi } from "vitest";
import { createFlightControlSettingsStore } from "./FlightControlSettingsStore.js";

function memoryStorage(): Storage {
  const values = new Map<string, string>();
  return {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value),
    removeItem: (key) => values.delete(key),
    clear: () => values.clear(),
    key: () => null,
    get length() { return values.size; },
  };
}

describe("FlightControlSettingsStore", () => {
  it("defaults off and persists changes on the air unit", () => {
    const storage = memoryStorage();
    const first = createFlightControlSettingsStore(storage);
    expect(first.isEnabled()).toBe(false);
    first.setEnabled(true);
    expect(createFlightControlSettingsStore(storage).isEnabled()).toBe(true);
  });

  it("treats malformed values and unavailable storage as disabled", () => {
    const storage = memoryStorage();
    storage.setItem("dronelink.air.flightControlEnabled.v1", "yes");
    expect(createFlightControlSettingsStore(storage).isEnabled()).toBe(false);
    const inaccessible = memoryStorage();
    inaccessible.getItem = vi.fn(() => { throw new Error("blocked"); });
    const store = createFlightControlSettingsStore(inaccessible);
    expect(store.isEnabled()).toBe(false);
    store.setEnabled(true);
    expect(store.isEnabled()).toBe(true);
  });

  it("keeps the in-memory setting when storage writes fail", () => {
    const storage = memoryStorage();
    storage.setItem = vi.fn(() => { throw new Error("blocked"); });
    const store = createFlightControlSettingsStore(storage);
    store.setEnabled(true);
    expect(store.isEnabled()).toBe(true);
  });
});
