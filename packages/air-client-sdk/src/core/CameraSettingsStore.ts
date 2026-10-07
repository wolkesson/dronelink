import type { VideoRotationDegrees } from "./WebRtcSessionManager.js";

/** Per-camera flip/rotation/fill, remembered so plugging back into the same physical camera restores it. */
export interface CameraTransform {
  horizontal: boolean;
  vertical: boolean;
  rotation: VideoRotationDegrees;
  fill: boolean;
}

const IDENTITY_TRANSFORM: CameraTransform = { horizontal: false, vertical: false, rotation: 0, fill: false };

// v2: keys switched from MediaDeviceInfo.deviceId to the camera's label (see
// CameraSettingsStore's doc comment) -- v1 data would never match anything under
// the new keying anyway, so there's nothing worth migrating; a version bump just
// makes that a clean no-op read instead of a confusing silent mismatch.
const STORAGE_KEY = "dronelink.air.cameraSettings.v2";

interface StoredState {
  perCamera: Record<string, CameraTransform>;
  defaultCameraKey: string | null;
}

// A fresh object every call -- readState()'s callers mutate what this returns
// in place (see setTransform/setDefaultCameraKey below), so a shared instance
// here would leak writes across calls whenever storage is empty/unavailable.
function emptyState(): StoredState {
  return { perCamera: {}, defaultCameraKey: null };
}

/**
 * The stored value as a CameraTransform, or null if it isn't one. `fill` was
 * added after v2 shipped, so an entry without it is still accepted (as
 * fill: false) rather than discarding that camera's saved flip/rotation.
 */
function toCameraTransform(value: unknown): CameraTransform | null {
  if (typeof value !== "object" || value === null) return null;
  const v = value as Record<string, unknown>;
  if (
    typeof v.horizontal !== "boolean" ||
    typeof v.vertical !== "boolean" ||
    !(v.rotation === 0 || v.rotation === 90 || v.rotation === 180 || v.rotation === 270) ||
    (v.fill !== undefined && typeof v.fill !== "boolean")
  ) {
    return null;
  }
  return { horizontal: v.horizontal, vertical: v.vertical, rotation: v.rotation, fill: v.fill === true };
}

function parseState(raw: string | null): StoredState {
  if (!raw) return emptyState();
  try {
    const parsed = JSON.parse(raw) as Partial<StoredState>;
    const perCamera: Record<string, CameraTransform> = {};
    if (typeof parsed.perCamera === "object" && parsed.perCamera !== null) {
      for (const [cameraKey, transform] of Object.entries(parsed.perCamera)) {
        const parsedTransform = toCameraTransform(transform);
        if (parsedTransform) perCamera[cameraKey] = parsedTransform;
      }
    }
    const defaultCameraKey = typeof parsed.defaultCameraKey === "string" ? parsed.defaultCameraKey : null;
    return { perCamera, defaultCameraKey };
  } catch {
    // Corrupt/foreign value under our key -- treat as if nothing were saved yet,
    // rather than letting a parse error break camera selection entirely.
    return emptyState();
  }
}

export interface CameraSettingsStore {
  /**
   * The saved flip/rotation/fill for a camera, or the identity transform if nothing was
   * saved for it yet. `cameraKey` should be the camera's own label (MediaDeviceInfo.label),
   * not its deviceId -- see this module's doc comment for why.
   */
  getTransform(cameraKey: string): CameraTransform;
  setTransform(cameraKey: string, transform: CameraTransform): void;
  getDefaultCameraKey(): string | null;
  setDefaultCameraKey(cameraKey: string): void;
}

/**
 * Persists per-camera flip/rotation/fill and the default camera choice on the air unit
 * itself (not synced to the ground side), since the phone's physical mounting --
 * and so which camera is "front"/"back" and which way it needs flipping -- is a
 * property of that phone, not of whichever ground station happens to be paired.
 *
 * Keyed by the camera's own label, not `MediaDeviceInfo.deviceId`/`groupId`.
 * Confirmed against a real Android WebView: those are salted per page load for
 * privacy (a fresh salt handed out on every navigation, not just every origin),
 * so they're only stable within one running session -- exactly what the live
 * ground-initiated camera-source protocol needs, and exactly what breaks a
 * setting meant to survive a reload/app-restart/reboot. The label ("camera 2,
 * facing back") comes straight from the platform's camera enumeration and isn't
 * salted, so it stays stable across reloads for the same physical camera. This
 * does assume distinct cameras report distinct labels, which holds for the
 * "camera N, facing ..." labels Chromium/WebView generate but isn't a hard
 * platform guarantee -- callers fall back to deviceId for a camera with no/an
 * empty label, accepting that one won't survive a reload either.
 *
 * Backed by `localStorage` by default; every read/write is wrapped so a browser
 * that blocks storage (private mode, disabled site data) degrades to losing
 * persistence across reloads rather than throwing and breaking camera selection.
 */
export function createCameraSettingsStore(
  storage: Pick<Storage, "getItem" | "setItem"> | undefined = globalThis.localStorage,
): CameraSettingsStore {
  function readState(): StoredState {
    if (!storage) return emptyState();
    try {
      return parseState(storage.getItem(STORAGE_KEY));
    } catch {
      return emptyState();
    }
  }

  function writeState(state: StoredState): void {
    if (!storage) return;
    try {
      storage.setItem(STORAGE_KEY, JSON.stringify(state));
    } catch {
      // Best-effort -- e.g. storage quota/private-mode. The in-memory change (the
      // caller's own videoTransform) still applies for the rest of this session.
    }
  }

  return {
    getTransform(cameraKey) {
      return readState().perCamera[cameraKey] ?? IDENTITY_TRANSFORM;
    },
    setTransform(cameraKey, transform) {
      const state = readState();
      state.perCamera[cameraKey] = transform;
      writeState(state);
    },
    getDefaultCameraKey() {
      return readState().defaultCameraKey;
    },
    setDefaultCameraKey(cameraKey) {
      const state = readState();
      state.defaultCameraKey = cameraKey;
      writeState(state);
    },
  };
}
