import type { PairingSocket } from "./PairingSession.js";

export type SessionState = "IDLE" | "CONNECTING" | "CONNECTED" | "FAILED";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

export class WebRtcSessionManager {
  private _state: SessionState = "IDLE";
  private pc: RTCPeerConnection | null = null;
  private dataChannel: RTCDataChannel | null = null;
  private readonly handlers = new Set<(data: Uint8Array) => void>();

  get state(): SessionState {
    return this._state;
  }

  /**
   * Create an RTCPeerConnection, open the "serial-relay" data channel, and
   * complete the SDP/ICE exchange over the already-paired signaling socket.
   * Resolves once the data channel transitions to open.
   */
  async connect(socket: PairingSocket): Promise<void> {
    this._state = "CONNECTING";

    this.pc = new RTCPeerConnection();
    const dc = this.pc.createDataChannel("serial-relay");
    this.dataChannel = dc;
    dc.binaryType = "arraybuffer";

    dc.onmessage = (event: MessageEvent) => {
      if (event.data instanceof ArrayBuffer) {
        const bytes = new Uint8Array(event.data);
        for (const handler of this.handlers) {
          handler(bytes);
        }
      }
    };

    // Forward our ICE candidates to the ground over the signaling socket.
    this.pc.onicecandidate = (event) => {
      if (event.candidate) {
        socket.send(
          JSON.stringify({ type: "ice-candidate", candidate: event.candidate.toJSON() }),
        );
      }
    };

    // Register the message handler BEFORE sending the offer so we never miss
    // an answer or ICE candidate that arrives immediately after the offer.
    socket.onMessage((data: string) => {
      let msg: unknown;
      try {
        msg = JSON.parse(data);
      } catch {
        return;
      }

      if (!isRecord(msg)) return;

      if (msg.type === "answer" && typeof msg.sdp === "string") {
        void this.pc?.setRemoteDescription({ type: "answer", sdp: msg.sdp });
      } else if (msg.type === "ice-candidate" && isRecord(msg.candidate)) {
        void this.pc?.addIceCandidate(msg.candidate as RTCIceCandidateInit);
      }
    });

    const offer = await this.pc.createOffer();
    await this.pc.setLocalDescription(offer);
    socket.send(JSON.stringify({ type: "offer", sdp: offer.sdp }));

    await new Promise<void>((resolve, reject) => {
      let settled = false;

      const succeed = () => {
        if (settled) return;
        settled = true;
        this._state = "CONNECTED";
        resolve();
      };

      const fail = (reason: string) => {
        if (settled) return;
        settled = true;
        this._state = "FAILED";
        reject(new Error(reason));
      };

      dc.onopen = succeed;

      dc.onerror = () => {
        fail("Data channel error");
      };

      this.pc!.onconnectionstatechange = () => {
        const cs = this.pc?.connectionState;
        if (cs === "failed" || cs === "closed") {
          fail(`WebRTC connection ${cs}`);
        }
      };
    });
  }

  /**
   * Send raw bytes over the "serial-relay" data channel.
   * Throws if the channel is not open.
   */
  sendBytes(data: Uint8Array): void {
    if (this._state !== "CONNECTED" || !this.dataChannel) {
      throw new Error("WebRTC data channel is not open.");
    }
    this.dataChannel.send(data as Uint8Array<ArrayBuffer>);
  }

  /**
   * Subscribe to bytes received from the remote data channel.
   * Returns an unsubscribe function, mirroring SerialTransport.subscribe().
   */
  subscribe(handler: (data: Uint8Array) => void): () => void {
    this.handlers.add(handler);
    return () => {
      this.handlers.delete(handler);
    };
  }
}
