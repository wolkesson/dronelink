import { isTailscaleCandidate } from "@dronelink/core-transport";
import type { PairingSocket } from "./PairingSession.js";

export type SessionState = "IDLE" | "CONNECTING" | "CONNECTED" | "FAILED";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

export type VideoQualityPreset = "auto" | "high" | "low" | "data-only";

const VIDEO_QUALITY_PRESETS: readonly VideoQualityPreset[] = ["auto", "high", "low", "data-only"];

function isVideoQualityPreset(value: unknown): value is VideoQualityPreset {
  return typeof value === "string" && (VIDEO_QUALITY_PRESETS as readonly string[]).includes(value);
}

// "quality" and "camera-source" are implemented today. Further ground-initiated
// controls (zoom, gain, contrast, ...) are expected to extend these unions with
// new discriminants later -- ground-client-sdk's requestVideoControl() forwards
// any {control, ...} shape unmodified, so adding a case here needs no
// ground-side change.
export type VideoControlRequest =
  | { control: "quality"; preset: VideoQualityPreset }
  | { control: "camera-source"; deviceId: string };

export type VideoControlState =
  | { control: "quality"; preset: VideoQualityPreset; videoActive: boolean }
  | { control: "camera-source"; deviceId: string; ok: boolean; error?: string };

/** A camera reported by enumerateDevices(), as sent to the ground in a camera-source-list push. */
export interface CameraSourceDevice {
  deviceId: string;
  label: string;
}

function isVideoControlRequest(value: unknown): value is VideoControlRequest {
  if (!isRecord(value)) return false;
  if (value.control === "quality") return isVideoQualityPreset(value.preset);
  if (value.control === "camera-source") {
    return typeof value.deviceId === "string" && value.deviceId.length > 0;
  }
  return false;
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
  private socket: PairingSocket | null = null;
  private dataChannel: RTCDataChannel | null = null;
  private videoSender: RTCRtpSender | null = null;
  private videoQualityPreset: VideoQualityPreset = "auto";
  private currentVideoTrack: MediaStreamTrack | null = null;
  private cameraSourceHandler: ((deviceId: string) => Promise<void>) | null = null;
  private pendingRenegotiation: { resolve: () => void; reject: (err: Error) => void } | null = null;
  private readonly handlers = new Set<(data: Uint8Array) => void>();
  private readonly connectTimeoutMs: number;

  constructor(options: WebRtcSessionManagerOptions = {}) {
    this.connectTimeoutMs = options.connectTimeoutMs ?? 15_000;
  }

  get state(): SessionState {
    return this._state;
  }

  /** Whether a video track is currently bound to the session (via connect() or addVideoTrack()). */
  get hasVideo(): boolean {
    return this.videoSender !== null;
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
    this.socket = socket;

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
            // A renegotiation answer (e.g. from addVideoTrack()) flows through this
            // same handler, since it's registered once for the socket's lifetime.
            this.pendingRenegotiation?.resolve();
          })
          .catch((err) => {
            console.error("setRemoteDescription failed:", err instanceof Error ? err.message : String(err));
            this.pendingRenegotiation?.reject(err instanceof Error ? err : new Error(String(err)));
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
      } else if (msg.type === "video-control-request" && isVideoControlRequest(msg)) {
        void this.applyVideoControlRequest(msg).then((state) => {
          socket.send(JSON.stringify({ type: "video-control-state", ...state }));
        });
      }
    });

    if (localStream) {
      for (const track of localStream.getTracks()) {
        const sender = this.pc.addTrack(track, localStream);
        if (track.kind === "video") {
          this.videoSender = sender;
          this.currentVideoTrack = track;
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
   *
   * If a "data-only" video quality preset is active, the swap is not forwarded to
   * the live sender (which stays paused via replaceTrack(null)) -- only the stored
   * track reference is updated, so the new source takes effect once the preset
   * changes away from "data-only".
   */
  async replaceVideoTrack(track: MediaStreamTrack): Promise<void> {
    if (!this.videoSender) {
      throw new Error("No active video sender to replace -- video was not bound at connect() time.");
    }
    this.currentVideoTrack = track;
    if (this.videoQualityPreset === "data-only") {
      return;
    }
    await this.videoSender.replaceTrack(track);
  }

  /**
   * Apply a ground-requested video quality preset to the outbound sender.
   * "data-only" pauses video entirely via replaceTrack(null) -- a disabled
   * MediaStreamTrack (track.enabled = false) still transmits blacked-out
   * frames, so this is the only way to actually stop sending video data.
   * No-op if no video track is bound.
   */
  private applyVideoQualityPreset(preset: VideoQualityPreset): void {
    if (!this.videoSender) return;

    if (preset === "data-only") {
      void this.videoSender.replaceTrack(null);
      this.videoQualityPreset = preset;
      return;
    }

    if (this.videoQualityPreset === "data-only") {
      void this.videoSender.replaceTrack(this.currentVideoTrack);
    }

    const parameters = this.videoSender.getParameters();
    const encoding: RTCRtpEncodingParameters = parameters.encodings[0] ?? {};

    if (preset === "auto") {
      delete encoding.maxBitrate;
      delete encoding.scaleResolutionDownBy;
      delete encoding.maxFramerate;
    } else if (preset === "high") {
      encoding.maxBitrate = 2_000_000;
      encoding.scaleResolutionDownBy = 1;
      encoding.maxFramerate = 30;
    } else if (preset === "low") {
      encoding.maxBitrate = 350_000;
      encoding.scaleResolutionDownBy = 2;
      encoding.maxFramerate = 15;
    }

    parameters.encodings[0] = encoding;
    void this.videoSender.setParameters(parameters);
    this.videoQualityPreset = preset;
  }

  /**
   * Register the handler that performs an actual camera switch for a
   * ground-requested "camera-source" control. Camera capture (getUserMedia,
   * device enumeration) is owned by the app layer, not this transport-only SDK,
   * so the handler is expected to acquire the new track and call
   * replaceVideoTrack()/addVideoTrack() itself, the same way a local device-
   * picker change would. Rejecting the returned promise acks the request with
   * ok: false and the rejection's message.
   */
  setCameraSourceHandler(handler: (deviceId: string) => Promise<void>): void {
    this.cameraSourceHandler = handler;
  }

  /**
   * Push the current camera list and active device to the ground side, so a
   * GUI viewer can offer camera-source choices. Unsolicited (not a reply to a
   * request) -- call after enumerating devices and after every successful
   * switch. No-op before connect() has set a socket.
   */
  publishCameraSources(devices: CameraSourceDevice[], activeDeviceId: string | null): void {
    if (!this.socket) return;
    this.socket.send(
      JSON.stringify({ type: "video-control-state", control: "camera-source-list", devices, activeDeviceId }),
    );
  }

  /**
   * Dispatch a ground-requested video control by its `control` discriminant.
   * This switch is the extension point for future controls (zoom, gain,
   * contrast, ...) -- adding one needs a new case here, not a new message
   * type or ground-side relay change.
   */
  private async applyVideoControlRequest(request: VideoControlRequest): Promise<VideoControlState> {
    switch (request.control) {
      case "quality":
        this.applyVideoQualityPreset(request.preset);
        return { control: "quality", preset: request.preset, videoActive: request.preset !== "data-only" };
      case "camera-source": {
        if (!this.cameraSourceHandler) {
          return {
            control: "camera-source",
            deviceId: request.deviceId,
            ok: false,
            error: "No camera source handler registered.",
          };
        }
        try {
          await this.cameraSourceHandler(request.deviceId);
          return { control: "camera-source", deviceId: request.deviceId, ok: true };
        } catch (err) {
          return {
            control: "camera-source",
            deviceId: request.deviceId,
            ok: false,
            error: err instanceof Error ? err.message : String(err),
          };
        }
      }
    }
  }

  /**
   * Add a video track to a session that connected data-only, via a fresh
   * offer/answer round on the same peer connection and signaling socket
   * (no ICE restart -- the existing data channel and transport are reused).
   * Throws if a video track is already bound (use replaceVideoTrack() to
   * swap it instead) or if the session isn't currently connected.
   */
  async addVideoTrack(track: MediaStreamTrack, stream: MediaStream): Promise<void> {
    if (this._state !== "CONNECTED" || !this.pc || !this.socket) {
      throw new Error("Cannot add video track: session is not connected.");
    }
    if (this.videoSender) {
      throw new Error("Video track already active -- use replaceVideoTrack() to swap it.");
    }

    this.videoSender = this.pc.addTrack(track, stream);
    this.currentVideoTrack = track;

    const offer = await this.pc.createOffer();
    await this.pc.setLocalDescription(offer);

    const offerMsg: Record<string, unknown> = { type: "offer", sdp: offer.sdp };
    const settings = track.getSettings();
    if (typeof settings.width === "number" && typeof settings.height === "number") {
      offerMsg.videoWidth = settings.width;
      offerMsg.videoHeight = settings.height;
    }

    try {
      await new Promise<void>((resolve, reject) => {
        const timeoutId = setTimeout(() => {
          this.pendingRenegotiation = null;
          reject(new Error("Adding video track timed out waiting for an answer."));
        }, this.connectTimeoutMs);

        this.pendingRenegotiation = {
          resolve: () => {
            clearTimeout(timeoutId);
            resolve();
          },
          reject: (err) => {
            clearTimeout(timeoutId);
            reject(err);
          },
        };

        this.socket!.send(JSON.stringify(offerMsg));
      });
    } catch (err) {
      // Roll back so a later retry starts from a clean, connect()-like state
      // instead of permanently wedging on a half-added sender.
      this.pc.removeTrack(this.videoSender);
      this.videoSender = null;
      this.currentVideoTrack = null;
      throw err;
    } finally {
      this.pendingRenegotiation = null;
    }
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
    this.socket = null;
    this.videoSender = null;
    this.videoQualityPreset = "auto";
    this.currentVideoTrack = null;
    this.pendingRenegotiation?.reject(new Error("Session disconnected."));
    this.pendingRenegotiation = null;
    this._state = "IDLE";
  }
}
