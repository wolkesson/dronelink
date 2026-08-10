# Spike 2: Camera/mic permission passthrough

## Goal

Let the PWA's existing `getUserMedia` call succeed unmodified inside the WebView shell, by implementing `WebChromeClient.onPermissionRequest` to grant `CAMERA`/`RECORD_AUDIO` runtime permissions through to the WebView.

## Scope

- Request the `CAMERA` and `RECORD_AUDIO` Android runtime permissions from the user.
- Implement `WebChromeClient.onPermissionRequest` to grant the corresponding web permissions (`PermissionRequest.RESOURCE_VIDEO_CAPTURE` / `RESOURCE_AUDIO_CAPTURE`) once the native permissions are held.
- No native camera/mic capture code — the WebView's browser engine handles capture via standard web APIs (`getUserMedia`). This is explicitly called out as "what not to add" in [`../README.md`](../README.md).

## Non-goals

- USB/serial bridging — Spike 4.
- Foreground service/wake lock/autostart — Spike 3.
- Any changes to the PWA's camera selection/preview UI (already built in Phase 2) — it should work unmodified once permissions are granted.

## Device requirements

An emulator's virtual camera is enough to validate the permission-plumbing path (permission dialog → `onPermissionRequest` → `getUserMedia` resolves). Confirm on a real device afterward for actual camera selection, resolution/quality, and permission-dialog UX before considering this spike done.

## Depends on

Spike 1 (WebView shell) should be in place first, since this spike builds on top of it. Can be developed on a separate branch in parallel and rebased.

## Files to reference

- [`../README.md`](../README.md) — "Camera/mic permission passthrough" responsibility and the "what not to add" constraint.
- `apps/air-webapp/src/components/` — existing camera selection/live preview UI (Phase 2 spikes 1–2) that this spike should make work unmodified inside the WebView.

## Exit criteria

- [ ] Native `CAMERA`/`RECORD_AUDIO` permission prompts appear and, once granted, `onPermissionRequest` passes them through to the WebView.
- [ ] The PWA's existing camera picker/live preview UI works inside the WebView shell the same way it does in desktop Chrome.
- [ ] No native capture code was added — only permission plumbing.
- [ ] Verified on at least one real device, not just the emulator.
