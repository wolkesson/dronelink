import { describe, expect, it, vi } from "vitest";
import { createCameraSettingsStore } from "./CameraSettingsStore.js";

/** In-memory stand-in for localStorage, so tests don't depend on a DOM/browser environment. */
function makeMemoryStorage(): Storage {
  const data = new Map<string, string>();
  return {
    getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => {
      data.set(key, value);
    },
    removeItem: (key: string) => {
      data.delete(key);
    },
    clear: () => data.clear(),
    key: () => null,
    get length() {
      return data.size;
    },
  };
}

describe("CameraSettingsStore", () => {
  it("returns the identity transform for a camera nothing was saved for yet", () => {
    const store = createCameraSettingsStore(makeMemoryStorage());
    expect(store.getTransform("cam-1")).toEqual({ horizontal: false, vertical: false, rotation: 0 });
  });

  it("round-trips a saved transform for a given camera key", () => {
    const store = createCameraSettingsStore(makeMemoryStorage());
    store.setTransform("cam-1", { horizontal: true, vertical: false, rotation: 90 });
    expect(store.getTransform("cam-1")).toEqual({ horizontal: true, vertical: false, rotation: 90 });
  });

  it("keeps transforms for different cameras independent", () => {
    const store = createCameraSettingsStore(makeMemoryStorage());
    store.setTransform("cam-1", { horizontal: true, vertical: false, rotation: 90 });
    store.setTransform("cam-2", { horizontal: false, vertical: true, rotation: 270 });

    expect(store.getTransform("cam-1")).toEqual({ horizontal: true, vertical: false, rotation: 90 });
    expect(store.getTransform("cam-2")).toEqual({ horizontal: false, vertical: true, rotation: 270 });
  });

  it("persists across store instances backed by the same storage", () => {
    const storage = makeMemoryStorage();
    createCameraSettingsStore(storage).setTransform("cam-1", { horizontal: true, vertical: true, rotation: 180 });

    expect(createCameraSettingsStore(storage).getTransform("cam-1")).toEqual({
      horizontal: true,
      vertical: true,
      rotation: 180,
    });
  });

  it("returns null for the default device until one is set", () => {
    const store = createCameraSettingsStore(makeMemoryStorage());
    expect(store.getDefaultCameraKey()).toBeNull();
  });

  it("round-trips the default camera key", () => {
    const store = createCameraSettingsStore(makeMemoryStorage());
    store.setDefaultCameraKey("cam-2");
    expect(store.getDefaultCameraKey()).toBe("cam-2");
  });

  it("setDefaultCameraKey doesn't disturb saved per-camera transforms", () => {
    const store = createCameraSettingsStore(makeMemoryStorage());
    store.setTransform("cam-1", { horizontal: true, vertical: false, rotation: 90 });
    store.setDefaultCameraKey("cam-1");
    expect(store.getTransform("cam-1")).toEqual({ horizontal: true, vertical: false, rotation: 90 });
  });

  it("setTransform doesn't disturb an already-saved default", () => {
    const store = createCameraSettingsStore(makeMemoryStorage());
    store.setDefaultCameraKey("cam-1");
    store.setTransform("cam-2", { horizontal: true, vertical: false, rotation: 90 });
    expect(store.getDefaultCameraKey()).toBe("cam-1");
  });

  it("treats corrupt JSON under the storage key as nothing saved, rather than throwing", () => {
    const storage = makeMemoryStorage();
    storage.setItem("dronelink.air.cameraSettings.v2", "{not json");
    const store = createCameraSettingsStore(storage);

    expect(store.getTransform("cam-1")).toEqual({ horizontal: false, vertical: false, rotation: 0 });
    expect(store.getDefaultCameraKey()).toBeNull();
  });

  it("ignores a malformed per-camera entry but keeps the rest of the saved state", () => {
    const storage = makeMemoryStorage();
    storage.setItem(
      "dronelink.air.cameraSettings.v2",
      JSON.stringify({
        perCamera: { "cam-1": { horizontal: true, vertical: false, rotation: 45 }, "cam-2": "nonsense" },
        defaultCameraKey: "cam-1",
      }),
    );
    const store = createCameraSettingsStore(storage);

    expect(store.getTransform("cam-1")).toEqual({ horizontal: false, vertical: false, rotation: 0 });
    expect(store.getTransform("cam-2")).toEqual({ horizontal: false, vertical: false, rotation: 0 });
    expect(store.getDefaultCameraKey()).toBe("cam-1");
  });

  it("degrades to in-memory-only (no throw) when storage.getItem throws", () => {
    const storage = makeMemoryStorage();
    storage.getItem = vi.fn(() => {
      throw new Error("storage disabled");
    });
    const store = createCameraSettingsStore(storage);

    expect(() => store.setTransform("cam-1", { horizontal: true, vertical: false, rotation: 90 })).not.toThrow();
    expect(store.getTransform("cam-1")).toEqual({ horizontal: false, vertical: false, rotation: 0 });
  });

  it("degrades to in-memory-only (no throw) when storage.setItem throws", () => {
    const storage = makeMemoryStorage();
    storage.setItem = vi.fn(() => {
      throw new Error("quota exceeded");
    });
    const store = createCameraSettingsStore(storage);

    expect(() => store.setDefaultCameraKey("cam-1")).not.toThrow();
  });

  it("works with no storage available at all (e.g. no localStorage in this context)", () => {
    const store = createCameraSettingsStore(undefined);
    expect(() => store.setTransform("cam-1", { horizontal: true, vertical: false, rotation: 90 })).not.toThrow();
    expect(store.getTransform("cam-1")).toEqual({ horizontal: false, vertical: false, rotation: 0 });
    expect(store.getDefaultCameraKey()).toBeNull();
  });
});
