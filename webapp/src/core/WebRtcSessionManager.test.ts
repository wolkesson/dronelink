/**
 * Placeholder tests for WebRtcSessionManager.
 *
 * TODO (Phase 0/1 spike):
 *   - Use a fake RTCPeerConnection (or a werift-based local peer) so tests run without a browser.
 *   - Assert that connect() transitions state to CONNECTED when both sides complete SDP/ICE.
 *   - Assert that sendBytes() delivers data to the remote peer's data channel.
 *   - Assert that state transitions to FAILED on ICE failure or timeout.
 *   - Assert that (Phase 3) reconnection backoff kicks in after a connection drop.
 */
import { describe, it, expect } from "vitest";
import { WebRtcSessionManager } from "./WebRtcSessionManager.js";

describe("WebRtcSessionManager", () => {
  it("starts in IDLE state", () => {
    const mgr = new WebRtcSessionManager();
    expect(mgr.state).toBe("IDLE");
  });

  it("TODO: connect() should transition to CONNECTED after SDP/ICE exchange", async () => {
    const mgr = new WebRtcSessionManager();
    // Expected to throw until implemented — this is a failing placeholder.
    await expect(mgr.connect()).rejects.toThrow("not implemented yet");
  });

  it("TODO: sendBytes() should relay bytes over the data channel", async () => {
    const mgr = new WebRtcSessionManager();
    await expect(mgr.sendBytes(new Uint8Array([0x01]))).rejects.toThrow("not implemented yet");
  });
});
