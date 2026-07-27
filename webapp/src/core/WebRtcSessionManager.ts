/**
 * WebRtcSessionManager — manages the WebRTC peer connection lifecycle.
 *
 * Responsibilities:
 *   - Create the RTCPeerConnection after a successful PairingSession.
 *   - Exchange SDP offer/answer and ICE candidates over the signaling WebSocket.
 *   - Open the ordered/reliable data channel used for opaque serial byte relay.
 *   - (Phase 2) Attach the getUserMedia video/audio track for camera forwarding.
 *   - (Phase 3) Handle reconnection / backoff on link drop.
 *
 * TODO (Phase 0/1 spike):
 *   - Accept the paired WebSocket from PairingSession.
 *   - Create RTCPeerConnection with ICE server config from the pairing bundle.
 *   - Generate SDP offer, send over signaling, await answer.
 *   - Add ICE candidates as they arrive on the signaling socket.
 *   - Open a data channel ("serial-relay") and expose send/receive interfaces.
 *   - Transition state: IDLE → CONNECTING → CONNECTED (or FAILED).
 */
export type SessionState = "IDLE" | "CONNECTING" | "CONNECTED" | "FAILED";

export class WebRtcSessionManager {
  private _state: SessionState = "IDLE";

  get state(): SessionState {
    return this._state;
  }

  /**
   * TODO: accept a paired WebSocket and begin the SDP/ICE exchange.
   */
  async connect(): Promise<void> {
    throw new Error("WebRtcSessionManager.connect() not implemented yet — see TODO above.");
  }

  /**
   * TODO: send opaque bytes over the "serial-relay" data channel.
   */
  async sendBytes(_data: Uint8Array): Promise<void> {
    throw new Error("WebRtcSessionManager.sendBytes() not implemented yet — see TODO above.");
  }
}
