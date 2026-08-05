import { RTCPeerConnection } from "werift";
import { MediaRecorder } from "werift/nonstandard";
import type { RTCDataChannel, RTCIceCandidateInit } from "werift";
import type { MediaStreamTrack } from "werift";
import { join } from "path";
import { mkdirSync } from "fs";

type DataChannelOpenCallback = (channel: RTCDataChannel) => void;
type DataChannelCloseCallback = () => void;

let onDataChannelOpenCallback: DataChannelOpenCallback | null = null;
let onDataChannelCloseCallback: DataChannelCloseCallback | null = null;
let activePc: RTCPeerConnection | null = null;
let activeRecorder: MediaRecorder | null = null;
const pendingCandidates: RTCIceCandidateInit[] = [];
let stateDir = "";

export function setStateDir(dir: string): void {
  stateDir = dir;
}

/** Returns the path for a video recording file for the given session ID. */
export function videoFilePath(dir: string, sessionId: string): string {
  return join(dir, `video-${sessionId}.webm`);
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

// Fix #13: match 100.64.0.0/10 (first octet 100, second octet 64-127)
export function isTailscaleCandidate(candidate: string): boolean {
  return /\b100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.\d{1,3}\.\d{1,3}\b/.test(candidate);
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

      if (stateDir) {
        mkdirSync(stateDir, { recursive: true });
      }
      const filePath = videoFilePath(stateDir || ".", sessionId);
      const recorder = new MediaRecorder({ tracks: [track], path: filePath });
      activeRecorder = recorder;
      void recorder.addTrack(track).catch((err: unknown) => {
        console.error(
          "Video recorder error:",
          err instanceof Error ? err.message : String(err),
        );
      });
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

export function handleSocketClose(): void {
  if (activePc) {
    void activePc.close().catch(() => undefined);
    activePc = null;
  }
  void stopRecorder();
  pendingCandidates.length = 0;
}

