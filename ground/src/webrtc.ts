import { RTCPeerConnection } from "werift";
import type { RTCDataChannel, RTCIceCandidateInit } from "werift";

type DataChannelOpenCallback = (channel: RTCDataChannel) => void;
type DataChannelCloseCallback = () => void;

let onDataChannelOpenCallback: DataChannelOpenCallback | null = null;
let onDataChannelCloseCallback: DataChannelCloseCallback | null = null;
let activePc: RTCPeerConnection | null = null;
const pendingCandidates: RTCIceCandidateInit[] = [];

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
  message: unknown,
  reply: (msg: unknown) => void,
): void {
  if (!isRecord(message)) return;

  if (message.type === "offer") {
    if (activePc) {
      return;
    }

    const sdp = typeof message.sdp === "string" ? message.sdp : "";
    const pc = new RTCPeerConnection({});
    activePc = pc;

    const buffered = pendingCandidates.splice(0);

    pc.onIceCandidate.subscribe((candidate) => {
      if (candidate) {
        reply({ type: "ice-candidate", candidate: candidate.toJSON() });
      }
    });

    pc.onDataChannel.subscribe((channel) => {
      if (channel.label !== "serial-relay") return;

      const openChannel = () => {
        onDataChannelOpenCallback?.(channel);
        channel.onclose = () => {
          onDataChannelCloseCallback?.();
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
          await pc.addIceCandidate(candidate);
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

export function handleSocketClose(): void {
  if (activePc) {
    void activePc.close().catch(() => undefined);
    activePc = null;
  }
  pendingCandidates.length = 0;
}
