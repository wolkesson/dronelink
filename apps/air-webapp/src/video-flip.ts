export interface FlipState {
  horizontal: boolean;
  vertical: boolean;
}

export interface FlippedVideoSource {
  /** The transformed outbound track -- feed this to the WebRTC sender in place of the raw camera track. */
  track: MediaStreamTrack;
  /** Stops the render loop and releases the intermediate video/canvas elements. Does not stop the source track. */
  stop(): void;
}

/**
 * Mirrors a live camera track horizontally and/or vertically for callers that need the flip baked
 * into the actual outbound frames (not just a local CSS transform) -- e.g. so the ground side, which
 * renders whatever bytes it receives with no transform of its own, sees a corrected picture.
 *
 * Raw MediaStreamTracks and RTCRtpSender have no flip capability, so this redraws every frame onto a
 * canvas with a mirrored 2D transform and captures the canvas as a new track via captureStream(). The
 * source track is decoded into a detached <video> element to drive the redraw loop; it is not attached
 * to the DOM and is not stopped by this function -- the caller owns the source track's lifecycle.
 */
export function createFlippedVideoTrack(sourceTrack: MediaStreamTrack, flip: FlipState): FlippedVideoSource {
  const settings = sourceTrack.getSettings();
  const width = settings.width ?? 1280;
  const height = settings.height ?? 720;
  const frameRate = settings.frameRate ?? 30;

  const sourceVideo = document.createElement("video");
  sourceVideo.muted = true;
  sourceVideo.playsInline = true;
  sourceVideo.srcObject = new MediaStream([sourceTrack]);
  void sourceVideo.play().catch(() => undefined);

  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d");
  if (!ctx) {
    throw new Error("Canvas 2D context unavailable -- cannot apply video flip.");
  }

  let rafId = 0;
  const drawFrame = () => {
    ctx.save();
    ctx.translate(flip.horizontal ? width : 0, flip.vertical ? height : 0);
    ctx.scale(flip.horizontal ? -1 : 1, flip.vertical ? -1 : 1);
    ctx.drawImage(sourceVideo, 0, 0, width, height);
    ctx.restore();
    rafId = requestAnimationFrame(drawFrame);
  };
  rafId = requestAnimationFrame(drawFrame);

  const [track] = canvas.captureStream(frameRate).getVideoTracks();

  return {
    track,
    stop() {
      cancelAnimationFrame(rafId);
      sourceVideo.pause();
      sourceVideo.srcObject = null;
      track.stop();
    },
  };
}
