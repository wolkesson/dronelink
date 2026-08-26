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
  private videoSender: RTCRtpSender | null = null;
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

    // Ground trickles ICE candidates as soon as it gathers them, which can race
    // ahead of its answer arriving and being applied here. addIceCandidate()
    // rejects if the remote description isn't set yet, so buffer candidates
    // that arrive before the answer and flush them once it's applied -- the
    // same pattern ground-client-sdk's webrtc.ts uses for its own two
    // offer/answer directions.
    let remoteDescriptionSet = false;
    const pendingCandidates: RTCIceCandidateInit[] = [];

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
        void this.pc
          ?.setRemoteDescription({ type: "answer", sdp: msg.sdp })
          .then(async () => {
            remoteDescriptionSet = true;
            const buffered = pendingCandidates.splice(0);
            for (const candidate of buffered) {
              await this.pc?.addIceCandidate(candidate).catch((err: unknown) => {
                console.warn(
                  "Failed to add buffered ICE candidate:",
                  err instanceof Error ? err.message : String(err),
                );
              });
            }
          })
          .catch((err) => {
            console.error("setRemoteDescription failed:", err instanceof Error ? err.message : String(err));
          });
      } else if (msg.type === "ice-candidate" && isRecord(msg.candidate)) {
        const candidateInit = msg.candidate as RTCIceCandidateInit;
        if (!remoteDescriptionSet) {
          pendingCandidates.push(candidateInit);
          return;
        }
        void this.pc?.addIceCandidate(candidateInit).catch((err) => {
          console.warn("addIceCandidate failed:", err instanceof Error ? err.message : String(err));
        });
      }
    });

    if (localStream) {
      for (const track of localStream.getTracks()) {
        const sender = this.pc.addTrack(track, localStream);
        if (track.kind === "video") {
          this.videoSender = sender;
        }
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

      const timeoutId = setTimeout(() => {
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
   * Swap the outbound video track in place via RTCRtpSender.replaceTrack, without
   * renegotiating the peer connection (no new offer/answer, no ICE restart, and the
   * data channel stays open). Only valid once a video track was already bound at
   * connect() time -- that's what negotiates the video m= line this reuses. Throws
   * if no video was bound at connect(), since adding video to a session that started
   * data-only needs a real renegotiation this method doesn't perform.
   *
   * The ground side keeps recording at the resolution it read from the original
   * offer (see WebRtcSessionManager's videoWidth/videoHeight side-channel and
   * ground-client-sdk's webrtc.ts), so replacing with a track of a different
   * resolution will desync the recorder from the actual frame size and can corrupt
   * the recording. Callers should only swap between sources of the same resolution.
   */
  async replaceVideoTrack(track: MediaStreamTrack): Promise<void> {
    if (!this.videoSender) {
      throw new Error("No active video sender to replace -- video was not bound at connect() time.");
    }
    await this.videoSender.replaceTrack(track);
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
    this.videoSender = null;
    this._state = "IDLE";
  }
}
