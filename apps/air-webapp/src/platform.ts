/**
 * Detects whether the PWA is running inside android-shell's WebView, so app.ts can pick
 * NativeBridgeTransport instead of WebSerialTransport. A user-agent marker (set by
 * MainActivity before loadUrl(), see android-shell's MainActivity.kt) is used rather than
 * feature-detecting navigator.serial's absence, so the check is synchronous and reliable
 * at the exact moment "Connect FC" is clicked — WebSerialTransport.open() requires a
 * synchronous user gesture, so transport selection can't wait on anything async.
 */
const ANDROID_SHELL_USER_AGENT_MARKER = "DroneLinkAndroidShell";

export function isAndroidShell(): boolean {
  return navigator.userAgent.includes(ANDROID_SHELL_USER_AGENT_MARKER);
}

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

/**
 * Dev-only: the `?fc=ws://localhost:<port>` query parameter points "Connect FC" at
 * tools/sitl-serial-bridge.mjs (and through it a Betaflight SITL build) instead of a USB
 * flight controller. Returns null when the parameter is absent or not allowed here, the URL
 * when it is usable, or throws for a parameter that is present but unusable, so a typo
 * surfaces in the FC panel instead of silently falling back to a real serial port.
 *
 * `devBuild` is `import.meta.env.DEV` at the call site: Vite replaces it with `false` in a
 * production build, so the override never ships. It is also refused inside android-shell,
 * whose USB bridge is the only serial path there.
 */
export function devSerialBridgeUrl(search: string, devBuild: boolean, androidShell: boolean): string | null {
  const value = new URLSearchParams(search).get("fc");
  if (value === null || !devBuild || androidShell) return null;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`Invalid ?fc= serial bridge URL: ${value}`);
  }
  if (url.protocol !== "ws:" || !LOOPBACK_HOSTS.has(url.hostname)) {
    throw new Error(`?fc= must be a ws://localhost:<port> serial bridge URL, got ${value}`);
  }
  return url.href;
}
