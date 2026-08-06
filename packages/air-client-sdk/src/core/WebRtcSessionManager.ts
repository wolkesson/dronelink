import { isTailscaleCandidate } from "@dronelink/core-transport";
import type { PairingSocket } from "./PairingSession.js";

export type SessionState = "IDLE" | "CONNECTING" | "CONNECTED" | "FAILED";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

export interface WebRtcSessionManagerOptions {
  connectTimeoutMs?: number;
}

export interface WebRtcConnectionMetrics {
  /** Round-trip time in milliseconds from the active candidate pair, or null if unavailable. */
  rttMs: number | null;
  bytesSent: number;
  bytesReceived: number;
}

export class WebRtcSessionManager {
  private _state: SessionState = "IDLE";
  private pc: RTCPeerConnection | null = null;
  private dataChannel: RTCDataChannel | null = null;
  private readonly handlers = new Set<(data: Uint8Array) => void>();
  private readonly connectTimeoutMs: number;

  constructor(options: WebRtcSessionManagerOptions = {}) {
    this.connectTimeoutMs = options.connectTimeoutMs ?? 15_000;
  }

  get state(): SessionState {
    return this._state;
  }

  /**
   * Create an RTCPeerConnection, open the "serial-relay" data channel, and
   * complete the SDP/ICE exchange over the already-paired signaling socket.
   * Resolves once the data channel transitions to open.
   * When isTailscaleTarget is true, only forwards ICE candidates in the
   * 100.64.0.0/10 range so non-routable candidates are not wasted on Tailscale.
   */
  async connect(socket: PairingSocket, isTailscaleTarget = false, localStream?: MediaStream): Promise<void> {
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
    // When pairing over Tailscale, only forward candidates in 100.64.0.0/10.
    this.pc.onicecandidate = (event) => {
      if (event.candidate) {
        if (isTailscaleTarget && !isTailscaleCandidate(event.candidate.candidate)) {
          return;
        }
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
        void this.pc?.setRemoteDescription({ type: "answer", sdp: msg.sdp }).catch((err) => {
          console.error("setRemoteDescription failed:", err instanceof Error ? err.message : String(err));
        });
      } else if (msg.type === "ice-candidate" && isRecord(msg.candidate)) {
        void this.pc?.addIceCandidate(msg.candidate as RTCIceCandidateInit).catch((err) => {
          console.warn("addIceCandidate failed:", err instanceof Error ? err.message : String(err));
        });
      }
    });

    if (localStream) {
      for (const track of localStream.getTracks()) {
        this.pc.addTrack(track, localStream);
      }
    }

    const offer = await this.pc.createOffer();
    await this.pc.setLocalDescription(offer);

    const offerMsg: Record<string, unknown> = { type: "offer", sdp: offer.sdp };
    if (localStream) {
      const videoTracks = localStream.getVideoTracks();
      if (videoTracks.length > 0) {
        const settings = videoTracks[0].getSettings();
        if (typeof settings.width === "number" && typeof settings.height === "number") {
          offerMsg.videoWidth = settings.width;
          offerMsg.videoHeight = settings.height;
        }
      }
    }
    socket.send(JSON.stringify(offerMsg));

    await new Promise<void>((resolve, reject) => {
      let settled = false;
      let timeoutId: ReturnType<typeof setTimeout> | undefined;

      const succeed = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timeoutId);
        this._state = "CONNECTED";
        resolve();
      };

      const fail = (reason: string) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeoutId);
        this._state = "FAILED";
        reject(new Error(reason));
      };

      timeoutId = setTimeout(() => {
        fail("WebRTC connection timed out");
      }, this.connectTimeoutMs);

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

  /**
   * Read the current round-trip time and cumulative byte counters from the
   * underlying RTCPeerConnection. Returns null when there is no active connection.
   * Sums bytes across the data channel and any outbound/inbound media so a single
   * pair of counters reflects total relay throughput.
   */
  async getConnectionMetrics(): Promise<WebRtcConnectionMetrics | null> {
    if (!this.pc) {
      return null;
    }

    const report = await this.pc.getStats();
    const metrics: WebRtcConnectionMetrics = { rttMs: null, bytesSent: 0, bytesReceived: 0 };

    report.forEach((stat: RTCStats) => {
      const record = stat as unknown as Record<string, unknown>;

      if (
        stat.type === "candidate-pair" &&
        record.state === "succeeded" &&
        typeof record.currentRoundTripTime === "number"
      ) {
        metrics.rttMs = record.currentRoundTripTime * 1000;
      }

      if (
        (stat.type === "outbound-rtp" || stat.type === "data-channel") &&
        typeof record.bytesSent === "number"
      ) {
        metrics.bytesSent += record.bytesSent;
      }

      if (
        (stat.type === "inbound-rtp" || stat.type === "data-channel") &&
        typeof record.bytesReceived === "number"
      ) {
        metrics.bytesReceived += record.bytesReceived;
      }
    });

    return metrics;
  }

  /** Tear down the peer connection and data channel. Safe to call when already idle. */
  disconnect(): void {
    this.dataChannel?.close();
    this.pc?.close();
    this.dataChannel = null;
    this.pc = null;
    this._state = "IDLE";
  }
}
