import { MediaStreamTrack, RTCPeerConnection } from "werift";
import { MediaRecorder } from "werift/nonstandard";
import type { RTCDataChannel, RTCIceCandidateInit } from "werift";
import type { RtpPacket } from "werift";
import { join } from "path";
import { mkdirSync } from "fs";
<<<<<<< HEAD:ground/src/webrtc.ts
import { randomUUID } from "crypto";
=======
import { isTailscaleCandidate } from "@dronelink/core-transport";
>>>>>>> origin/main:packages/ground-client-sdk/src/webrtc.ts

type DataChannelOpenCallback = (channel: RTCDataChannel) => void;
type DataChannelCloseCallback = () => void;

let onDataChannelOpenCallback: DataChannelOpenCallback | null = null;
let onDataChannelCloseCallback: DataChannelCloseCallback | null = null;
let activePc: RTCPeerConnection | null = null;
let activeRecorder: MediaRecorder | null = null;
let activeVideoTrack: MediaStreamTrack | null = null;
let activeGuiPc: RTCPeerConnection | null = null;
let activeGuiForwarder: RtpTrackForwarder | null = null;
let guiRemoteDescriptionSet = false;
const pendingCandidates: RTCIceCandidateInit[] = [];
const pendingGuiCandidates: RTCIceCandidateInit[] = [];
let stateDir = "";

export function setStateDir(dir: string): void {
  stateDir = dir;
}

/** Returns the path for a video recording file for the given session ID. */
export function videoFilePath(dir: string, sessionId: string): string {
  return join(dir, `video-${sessionId}.webm`);
}

export interface RtpTrackForwarder {
  track: MediaStreamTrack;
  stop(): void;
}

export function forwardRtpTrack(source: Pick<MediaStreamTrack, "kind" | "onReceiveRtp">): RtpTrackForwarder {
  const track = new MediaStreamTrack({ kind: source.kind });
  const subscription = source.onReceiveRtp.subscribe((rtp: RtpPacket) => {
    track.writeRtp(rtp.clone());
  });

  return {
    track,
    stop(): void {
      subscription.unSubscribe();
      track.stop();
    },
  };
}

export function setDataChannelCallbacks(
  onOpen: DataChannelOpenCallback,
  onClose: DataChannelCloseCallback,
): void {
  onDataChannelOpenCallback = onOpen;
  onDataChannelCloseCallback = onClose;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

export function handleSignalingMessage(
  message: Record<string, unknown>,
  reply: (msg: unknown) => void,
  isTailscale = false,
): void {
  if (!isRecord(message)) return;

  if (message.type === "offer") {
    if (activePc) {
      console.warn("WebRTC: ignoring offer — connection already active");
      return;
    }

    // Fresh per-connection ID, distinct from the pairing-time session ID (which is
    // fixed for the whole /ground process lifetime). Using the pairing session ID
    // here meant every recording during a single `npm start` run shared the same
    // filename — a reconnect while a previous recording's finalization was still
    // writing could corrupt the file. Each WebRTC connection now gets its own.
    const recordingId = randomUUID();

    const sdp = typeof message.sdp === "string" ? message.sdp : "";
    const pc = new RTCPeerConnection({});
    activePc = pc;

    // Use dimensions signaled in the offer. If missing or invalid, fall back to 320x240
    // (werift's MediaRecorder default is 640x360 which causes shearing artifacts).
    const videoWidth: number = typeof message.videoWidth === "number" ? message.videoWidth : 320;
    const videoHeight: number = typeof message.videoHeight === "number" ? message.videoHeight : 240;

    const buffered = pendingCandidates.splice(0);

    pc.onIceCandidate.subscribe((candidate) => {
      if (candidate) {
        if (isTailscale && !isTailscaleCandidate(candidate.candidate)) {
          return;
        }
        reply({ type: "ice-candidate", candidate: candidate.toJSON() });
      }
    });

    pc.onTrack.subscribe((track: MediaStreamTrack) => {
      if (track.kind !== "video") return;
      activeVideoTrack = track;

      if (stateDir) {
        mkdirSync(stateDir, { recursive: true });
      }
      const filePath = videoFilePath(stateDir || ".", recordingId);

      if (typeof message.videoWidth !== "number" || typeof message.videoHeight !== "number") {
        console.warn(
          "Video dimensions not signaled in offer; falling back to 320x240 for recording.",
        );
      }

      const recorder = new MediaRecorder({
        tracks: [track],
        path: filePath,
        width: videoWidth,
        height: videoHeight,
        // No audio track exists for this recording, so lip-sync buffering (which only
        // synchronizes audio+video timing) serves no purpose here — disabling it also
        // sidesteps a bug in werift's LipsyncCallback stage where a duplicate end-of-
        // stream signal throws "this.videoOutput is not a function", which was
        // interrupting the WebM finalization (Duration/SegmentSize patch-up) and
        // corrupting playback.
        disableLipSync: true,
        
      });
      activeRecorder = recorder;
<<<<<<< HEAD:ground/src/webrtc.ts
      void recorder.addTrack(track)
      .then(() => {console.log(`Video recording (${videoWidth}x${videoHeight}) started: ${filePath}`);})
      .catch((err: unknown) => {
        console.error(
          "Video recorder error:",
          err instanceof Error ? err.message : String(err),
        );
      });
=======
>>>>>>> origin/main:packages/ground-client-sdk/src/webrtc.ts
    });

    pc.onDataChannel.subscribe((channel) => {
      if (channel.label !== "serial-relay") return;

      const openChannel = () => {
        onDataChannelOpenCallback?.(channel);
        channel.onclose = () => {
          onDataChannelCloseCallback?.();
          void stopRecorder();
          void pc.close().catch(() => undefined);
          activePc = null;
        };
      };

      if (channel.readyState === "open") {
        openChannel();
      } else {
        channel.onopen = openChannel;
      }
    });

    pc.setRemoteDescription({ type: "offer", sdp })
      .then(async () => {
        const answer = await pc.createAnswer();
        await pc.setLocalDescription(answer);
        reply({ type: "answer", sdp: answer.sdp });
        for (const candidate of buffered) {
          await pc.addIceCandidate(candidate).catch((err: unknown) => {
            console.warn(
              "Failed to add buffered ICE candidate:",
              err instanceof Error ? err.message : String(err),
            );
          });
        }
      })
      .catch((err: unknown) => {
        const msg = err instanceof Error ? err.message : String(err);
        console.error("WebRTC offer handling failed:", msg);
        activePc = null;
      });

    return;
  }

  if (message.type === "ice-candidate") {
    if (!isRecord(message.candidate) || typeof message.candidate.candidate !== "string") return;

    const candidateInit: RTCIceCandidateInit = {
      candidate: message.candidate.candidate,
      sdpMid: typeof message.candidate.sdpMid === "string" ? message.candidate.sdpMid : null,
      sdpMLineIndex:
        typeof message.candidate.sdpMLineIndex === "number"
          ? message.candidate.sdpMLineIndex
          : null,
      usernameFragment:
        typeof message.candidate.usernameFragment === "string"
          ? message.candidate.usernameFragment
          : null,
    };

    if (!activePc) {
      pendingCandidates.push(candidateInit);
      return;
    }

    activePc.addIceCandidate(candidateInit).catch((err: unknown) => {
      const msg = err instanceof Error ? err.message : String(err);
      console.error("addIceCandidate failed:", msg);
    });
  }
}

export function handleGuiSignalingMessage(
  message: unknown,
  reply: (msg: unknown) => void,
  isTailscale = false,
): void {
  if (!isRecord(message)) return;

  if (message.type === "offer") {
    if (activeGuiPc) {
      reply({ type: "error", message: "A GUI viewer is already connected." });
      return;
    }

    if (!activeVideoTrack) {
      reply({ type: "error", message: "No incoming video is available yet." });
      return;
    }

    const sdp = typeof message.sdp === "string" ? message.sdp : "";
    const pc = new RTCPeerConnection({});
    const forwarder = forwardRtpTrack(activeVideoTrack);
    activeGuiPc = pc;
    activeGuiForwarder = forwarder;
    guiRemoteDescriptionSet = false;
    pc.addTrack(forwarder.track);

    pc.onIceCandidate.subscribe((candidate) => {
      if (!candidate) return;
      if (isTailscale && !isTailscaleCandidate(candidate.candidate)) {
        return;
      }
      reply({ type: "ice-candidate", candidate: candidate.toJSON() });
    });

    pc.setRemoteDescription({ type: "offer", sdp })
      .then(async () => {
        guiRemoteDescriptionSet = true;
        const buffered = pendingGuiCandidates.splice(0);
        for (const candidate of buffered) {
          await pc.addIceCandidate(candidate).catch((err: unknown) => {
            console.warn(
              "Failed to add buffered GUI ICE candidate:",
              err instanceof Error ? err.message : String(err),
            );
          });
        }
        const answer = await pc.createAnswer();
        await pc.setLocalDescription(answer);
        reply({ type: "answer", sdp: answer.sdp });
      })
      .catch((err: unknown) => {
        const msg = err instanceof Error ? err.message : String(err);
        console.error("GUI WebRTC offer handling failed:", msg);
        closeGuiPeer();
      });

    return;
  }

  if (message.type === "ice-candidate") {
    if (!isRecord(message.candidate) || typeof message.candidate.candidate !== "string") return;

    const candidateInit: RTCIceCandidateInit = {
      candidate: message.candidate.candidate,
      sdpMid: typeof message.candidate.sdpMid === "string" ? message.candidate.sdpMid : null,
      sdpMLineIndex:
        typeof message.candidate.sdpMLineIndex === "number"
          ? message.candidate.sdpMLineIndex
          : null,
      usernameFragment:
        typeof message.candidate.usernameFragment === "string"
          ? message.candidate.usernameFragment
          : null,
    };

    if (!activeGuiPc || !guiRemoteDescriptionSet) {
      pendingGuiCandidates.push(candidateInit);
      return;
    }

    activeGuiPc.addIceCandidate(candidateInit).catch((err: unknown) => {
      const msg = err instanceof Error ? err.message : String(err);
      console.error("GUI addIceCandidate failed:", msg);
    });
  }
}

async function stopRecorder(): Promise<void> {
  if (activeRecorder) {
    const recorder = activeRecorder;
    activeRecorder = null;
    await recorder.stop().catch((err: unknown) => {
      console.warn(
        "Video recorder stop error:",
        err instanceof Error ? err.message : String(err),
      );
    });
  }
}

function closeGuiPeer(): void {
  if (activeGuiPc) {
    void activeGuiPc.close().catch(() => undefined);
    activeGuiPc = null;
  }
  activeGuiForwarder?.stop();
  activeGuiForwarder = null;
  guiRemoteDescriptionSet = false;
  pendingGuiCandidates.length = 0;
}

export function handleGuiSocketClose(): void {
  closeGuiPeer();
}

export function handleSocketClose(): void {
  if (activePc) {
    void activePc.close().catch(() => undefined);
    activePc = null;
  }
  void stopRecorder();
  activeVideoTrack = null;
  closeGuiPeer();
  pendingCandidates.length = 0;
}
