const STORAGE_KEY = "dronelink.air.flightControlEnabled.v1";

export interface FlightControlSettingsStore {
  isEnabled(): boolean;
  setEnabled(enabled: boolean): void;
}

/** Air-unit opt-in setting. Missing, malformed, or unavailable storage always means off. */
export function createFlightControlSettingsStore(
  storage?: Pick<Storage, "getItem" | "setItem">,
): FlightControlSettingsStore {
  let resolvedStorage = storage;
  if (resolvedStorage === undefined) {
    try {
      resolvedStorage = globalThis.localStorage;
    } catch {
      resolvedStorage = undefined;
    }
  }
  let enabled = false;
  let storageFailed = false;

  function read(): boolean {
    if (!resolvedStorage || storageFailed) return enabled;
    try {
      return resolvedStorage.getItem(STORAGE_KEY) === "true";
    } catch {
      storageFailed = true;
      return enabled;
    }
  }

  return {
    isEnabled: read,
    setEnabled(value) {
      enabled = value;
      try {
        resolvedStorage?.setItem(STORAGE_KEY, String(value));
      } catch {
        storageFailed = true;
        // Storage is best-effort; keep the in-memory choice for this page session.
      }
    },
  };
}
