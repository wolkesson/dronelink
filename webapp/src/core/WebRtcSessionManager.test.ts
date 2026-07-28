import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { WebRtcSessionManager } from "./WebRtcSessionManager.js";
import type { PairingSocket } from "./PairingSession.js";

function makeMockSocket(): PairingSocket {
  return {
    send: vi.fn(),
    close: vi.fn(),
    onOpen: vi.fn(),
    onMessage: vi.fn(),
    onError: vi.fn(),
    onClose: vi.fn(),
  };
}

describe("WebRtcSessionManager", () => {
  it("starts in IDLE state", () => {
    const mgr = new WebRtcSessionManager();
    expect(mgr.state).toBe("IDLE");
  });

  it("sendBytes() throws when not connected", () => {
    const mgr = new WebRtcSessionManager();
    expect(() => mgr.sendBytes(new Uint8Array([0x01]))).toThrow();
  });

  it("subscribe() returns a working unsubscribe function", () => {
    const mgr = new WebRtcSessionManager();
    const handler = vi.fn();
    const unsub = mgr.subscribe(handler);
    expect(typeof unsub).toBe("function");
    unsub();
  });

  it("connect() transitions to CONNECTING then CONNECTED when data channel opens", async () => {
    const openRef = { fn: null as ((() => void) | null) };

    const dc = {
      binaryType: "arraybuffer",
      onmessage: null as unknown,
      onerror: null as unknown,
      onclose: null as unknown,
      send: vi.fn(),
    };
    Object.defineProperty(dc, "onopen", {
      set(fn: (() => void) | null) {
        if (fn) openRef.fn = fn;
      },
      get() {
        return openRef.fn;
      },
      configurable: true,
    });

    const pc = {
      connectionState: "new",
      onicecandidate: null as unknown,
      onconnectionstatechange: null as unknown,
      onicecandidateerror: null as unknown,
      createDataChannel: vi.fn(() => dc),
      createOffer: vi.fn(async () => ({ type: "offer" as const, sdp: "v=0\r\n" })),
      setLocalDescription: vi.fn(async () => {}),
      close: vi.fn(),
    };

    vi.stubGlobal(
      "RTCPeerConnection",
      vi.fn(function MockRTCPeerConnection(this: unknown) {
        return pc;
      }),
    );

    try {
      const mgr = new WebRtcSessionManager();
      const socket = makeMockSocket();

      const connectPromise = mgr.connect(socket);
      expect(mgr.state).toBe("CONNECTING");

      // Drain microtasks so the async setup (createOffer, setLocalDescription) completes
      for (let i = 0; i < 5; i++) {
        await Promise.resolve();
      }

      // Simulate the data channel opening
      openRef.fn?.();

      await connectPromise;
      expect(mgr.state).toBe("CONNECTED");
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

