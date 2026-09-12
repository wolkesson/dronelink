export type RotationDegrees = 0 | 90 | 180 | 270;

export interface VideoTransform {
  horizontal: boolean;
  vertical: boolean;
  rotation: RotationDegrees;
}

export interface TransformedVideoSource {
  /** The transformed outbound track -- feed this to the WebRTC sender in place of the raw camera track. */
  track: MediaStreamTrack;
  /** Stops the render loop and releases the intermediate video/canvas elements. Does not stop the source track. */
  stop(): void;
}

/**
 * Applies a ground-requested flip/rotation to a live camera track for callers that need the
 * transform baked into the actual outbound frames (not just a local CSS transform) -- e.g. so the
 * ground side, which renders whatever bytes it receives with no transform of its own, sees a
 * corrected picture.
 *
 * Raw MediaStreamTracks and RTCRtpSender have neither capability, so this redraws every frame onto
 * a canvas with a mirrored/rotated 2D transform and captures the canvas as a new track via
 * captureStream(). The source track is decoded into a detached <video> element to drive the redraw
 * loop; it is not attached to the DOM and is not stopped by this function -- the caller owns the
 * source track's lifecycle.
 *
 * The canvas keeps the source track's own width/height regardless of rotation, so a 90/270 rotation
 * is letterboxed (scaled to fit within those bounds) rather than swapping the outbound dimensions --
 * the ground side's MediaRecorder is sized once from the original SDP offer and never re-reads
 * dimensions afterward, so changing them mid-session would desync it (see
 * WebRtcSessionManager.replaceVideoTrack's docs and ARCHITECTURE.md's resolution-change limitation).
 * Flip and 180-degree rotation don't change the content's bounding box, so they fill the canvas
 * exactly with no letterboxing.
 */
export function createTransformedVideoTrack(
  sourceTrack: MediaStreamTrack,
  transform: VideoTransform,
): TransformedVideoSource {
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
    throw new Error("Canvas 2D context unavailable -- cannot apply video flip/rotation.");
  }

  const rotatedSideways = transform.rotation === 90 || transform.rotation === 270;
  const rotatedBoundsWidth = rotatedSideways ? height : width;
  const rotatedBoundsHeight = rotatedSideways ? width : height;
  const containScale = Math.min(width / rotatedBoundsWidth, height / rotatedBoundsHeight);

  let rafId = 0;
  const drawFrame = () => {
    ctx.save();
    ctx.fillStyle = "black";
    ctx.fillRect(0, 0, width, height);
    // Order matters: scale (flip) is applied to the raw frame first, then the
    // already-flipped image is rotated and centered -- so flip always mirrors
    // what the camera captured, and rotate corrects the mounting orientation
    // on top of that.
    ctx.translate(width / 2, height / 2);
    ctx.rotate((transform.rotation * Math.PI) / 180);
    ctx.scale(
      containScale * (transform.horizontal ? -1 : 1),
      containScale * (transform.vertical ? -1 : 1),
    );
    ctx.drawImage(sourceVideo, -width / 2, -height / 2, width, height);
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
