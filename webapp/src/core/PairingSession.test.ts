/**
 * Placeholder tests for PairingSession.
 *
 * TODO (Phase 0 pairing spike):
 *   - Mock the WebSocket (or use a real local wss:// test server) so tests run without a browser.
 *   - Assert that pair() with a valid droneops:// URI transitions state to PAIRED.
 *   - Assert that pair() with a wrong token transitions state to FAILED.
 *   - Assert that cert fingerprint mismatch is rejected.
 *   - Assert manual {host, token} input also reaches PAIRED with a cooperative server.
 */
import { describe, it, expect } from "vitest";
import { PairingSession } from "./PairingSession.js";

describe("PairingSession", () => {
  it("starts in UNPAIRED state", () => {
    const session = new PairingSession();
    expect(session.state).toBe("UNPAIRED");
  });

  it("TODO: pair() should transition to PAIRED on success", async () => {
    const session = new PairingSession();
    // Expected to throw until implemented — this is a failing placeholder.
    await expect(
      session.pair("droneops://pair?host=localhost&port=8443&session=s1&token=tok&fp=aa:bb"),
    ).rejects.toThrow("not implemented yet");
  });
});
