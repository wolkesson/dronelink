/**
 * PairingSession — manages the pairing handshake between the air-side PWA and ground software.
 *
 * Pairing flow (QR primary, manual fallback):
 *   1. Ground software generates a session bundle: session ID, random token, self-signed TLS
 *      cert fingerprint. Encodes it as a QR code:
 *        droneops://pair?host=...&port=...&session=...&token=...&fp=...
 *   2. Air-side PWA scans the QR (via getUserMedia + a JS barcode library) or user enters
 *      host + token manually (lower assurance, documented as such).
 *   3. PWA connects over `wss://`, pins the cert against the fingerprint, and presents the
 *      token before any SDP/ICE exchange is allowed.
 *
 * TODO (Phase 0 pairing spike):
 *   - Parse the droneops:// URI / manual host+token form.
 *   - Open a WebSocket to wss://<host>:<port>.
 *   - Pin the server cert against the fingerprint (SubtleCrypto or a JS TLS library).
 *   - Present the session ID + token and await a success/reject response.
 *   - Transition state from UNPAIRED → AUTHENTICATING → PAIRED (or FAILED).
 *   - Expose paired session credentials to WebRtcSessionManager.
 */
export type PairingState = "UNPAIRED" | "AUTHENTICATING" | "PAIRED" | "FAILED";

export class PairingSession {
  private _state: PairingState = "UNPAIRED";

  get state(): PairingState {
    return this._state;
  }

  /**
   * TODO: parse a droneops:// URI or accept {host, token} directly, then initiate the
   * WebSocket handshake and cert-pinning flow.
   */
  async pair(_input: string | { host: string; port: number; token: string }): Promise<void> {
    throw new Error("PairingSession.pair() not implemented yet — see TODO above.");
  }
}
