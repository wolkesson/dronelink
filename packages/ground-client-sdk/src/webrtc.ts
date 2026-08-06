import { MediaStreamTrack, RTCPeerConnection } from "werift";
import { MediaRecorder } from "werift/nonstandard";
import type { RTCDataChannel, RTCIceCandidateInit } from "werift";
import type { RtpPacket } from "werift";
import { join } from "path";
import { mkdirSync } from "fs";
import { isTailscaleCandidate } from "@dronelink/core-transport";

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

/** Parse and validate videoWidth/videoHeight from a signaling offer message. */
export function parseOfferDimensions(
  message: Record<string, unknown>,
): { width: number; height: number } | undefined {
  const { videoWidth, videoHeight } = message;
  if (typeof videoWidth === "number" && typeof videoHeight === "number") {
    return { width: videoWidth, height: videoHeight };
  }
  return undefined;
}

export function handleSignalingMessage(
  message: unknown,
  reply: (msg: unknown) => void,
  isTailscale = false,
  sessionId = "session",
): void {
  if (!isRecord(message)) return;

  if (message.type === "offer") {
    if (activePc) {
      console.warn("WebRTC: ignoring offer — connection already active");
      return;
    }

    const sdp = typeof message.sdp === "string" ? message.sdp : "";
    const dims = parseOfferDimensions(message);
    const pc = new RTCPeerConnection({});
    activePc = pc;

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
      const filePath = videoFilePath(stateDir || ".", sessionId);

      // Use dimensions signaled in the offer. If missing, fall back to 320x240
      // (werift's MediaRecorder default is 640x360 which causes shearing artifacts).
      const { width, height } = dims ?? { width: 320, height: 240 };
      if (!dims) {
        console.warn(
          "Video dimensions not signaled in offer; falling back to 320x240 for recording.",
        );
      }

      const recorder = new MediaRecorder({ tracks: [track], path: filePath, width, height });
      activeRecorder = recorder;
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
