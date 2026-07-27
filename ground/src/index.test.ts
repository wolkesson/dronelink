/**
 * Placeholder tests for the ground software.
 *
 * TODO (SITL integration — Phase 0/1):
 *   Wire in an INAV SITL process as a service (see .github/workflows/ground-ci.yml for the
 *   stub).  These tests should:
 *     1. Start the signaling server.
 *     2. Perform the pairing handshake.
 *     3. Open a WebRTC data channel.
 *     4. Send a recorded byte-stream fixture (from /protocol/fixtures) over the channel.
 *     5. Assert that the byte-stream arrives intact at the local TCP bridge socket.
 *     6. Assert that SITL (listening on that TCP socket) echoes back expected telemetry.
 */
import { describe, it, expect } from "vitest";
import { createSignalingServer } from "./signaling.js";

describe("signaling server", () => {
  it("creates a WebSocket server without throwing", () => {
    // TODO: replace with a real integration test once the pairing handshake is implemented.
    let server: ReturnType<typeof createSignalingServer> | undefined;
    expect(() => {
      server = createSignalingServer(0); // port 0 = OS-assigned, avoids conflicts in CI
    }).not.toThrow();
    server?.close();
  });
});
