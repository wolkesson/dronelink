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
