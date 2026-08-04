import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { WebRtcSessionManager, isTailscaleCandidate } from "./WebRtcSessionManager.js";
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

/** Build a minimal mock RTCPeerConnection + data channel for connect() tests. */
function makeMockPc() {
  const openRef = { fn: null as ((() => void) | null) };
  const iceCandidateRef = { fn: null as ((event: { candidate: unknown }) => void) | null };

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
    onconnectionstatechange: null as unknown,
    onicecandidateerror: null as unknown,
    createDataChannel: vi.fn(() => dc),
    createOffer: vi.fn(async () => ({ type: "offer" as const, sdp: "v=0\r\n" })),
    setLocalDescription: vi.fn(async () => {}),
    close: vi.fn(),
  };
  Object.defineProperty(pc, "onicecandidate", {
    set(fn: ((event: { candidate: unknown }) => void) | null) {
      if (fn) iceCandidateRef.fn = fn;
    },
    get() {
      return iceCandidateRef.fn;
    },
    configurable: true,
  });

  return { pc, dc, openRef, iceCandidateRef };
}

describe("isTailscaleCandidate", () => {
  it("matches addresses in 100.64.0.0/10 (second octet 64–127)", () => {
    expect(isTailscaleCandidate("candidate:1 1 UDP 2130706431 100.64.0.1 51820 typ host")).toBe(true);
    expect(isTailscaleCandidate("candidate:1 1 UDP 2130706431 100.100.10.5 51820 typ host")).toBe(true);
    expect(isTailscaleCandidate("candidate:1 1 UDP 2130706431 100.127.255.255 51820 typ host")).toBe(true);
  });

  it("rejects addresses outside 100.64.0.0/10", () => {
    expect(isTailscaleCandidate("candidate:1 1 UDP 2130706431 100.63.0.1 51820 typ host")).toBe(false);
    expect(isTailscaleCandidate("candidate:1 1 UDP 2130706431 100.128.0.1 51820 typ host")).toBe(false);
    expect(isTailscaleCandidate("candidate:1 1 UDP 2130706431 192.168.1.1 51820 typ host")).toBe(false);
    expect(isTailscaleCandidate("candidate:1 1 UDP 2130706431 10.0.0.1 51820 typ host")).toBe(false);
  });
});

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
    const { pc, openRef } = makeMockPc();

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

  it("connect() rejects with 'WebRTC connection timed out' when the data channel never opens", async () => {
    vi.useFakeTimers();
    const { pc } = makeMockPc();

    vi.stubGlobal(
      "RTCPeerConnection",
      vi.fn(function MockRTCPeerConnection(this: unknown) {
        return pc;
      }),
    );

    try {
      const mgr = new WebRtcSessionManager({ connectTimeoutMs: 100 });
      const socket = makeMockSocket();

      const connectPromise = mgr.connect(socket);

      // Drain microtasks so async setup completes before advancing timers
      for (let i = 0; i < 5; i++) {
        await Promise.resolve();
      }

      // Attach the rejection assertion BEFORE advancing timers so the handler is
      // already registered when the timeout fires (prevents unhandled-rejection warning).
      const assertion = expect(connectPromise).rejects.toThrow("WebRTC connection timed out");
      await vi.advanceTimersByTimeAsync(200);
      await assertion;

      expect(mgr.state).toBe("FAILED");
    } finally {
      vi.useRealTimers();
      vi.unstubAllGlobals();
    }
  });

  it("connect() forwards only 100.64.0.0/10 candidates when isTailscaleTarget=true", async () => {
    const { pc, openRef, iceCandidateRef } = makeMockPc();

    vi.stubGlobal(
      "RTCPeerConnection",
      vi.fn(function MockRTCPeerConnection(this: unknown) {
        return pc;
      }),
    );

    try {
      const mgr = new WebRtcSessionManager();
      const socket = makeMockSocket();

      const connectPromise = mgr.connect(socket, true);

      // Drain microtasks so the async setup completes and onicecandidate is wired
      for (let i = 0; i < 5; i++) {
        await Promise.resolve();
      }

      const makeFakeCandidate = (ip: string) => ({
        candidate: `candidate:1 1 UDP 2130706431 ${ip} 51820 typ host`,
        toJSON() {
          return { candidate: this.candidate, sdpMid: "0", sdpMLineIndex: 0 };
        },
      });

      // Tailscale candidate — should be forwarded
      iceCandidateRef.fn?.({ candidate: makeFakeCandidate("100.100.10.5") });
      // Non-Tailscale candidate — should be dropped
      iceCandidateRef.fn?.({ candidate: makeFakeCandidate("192.168.1.1") });
      // Another Tailscale candidate — should be forwarded
      iceCandidateRef.fn?.({ candidate: makeFakeCandidate("100.64.0.1") });

      // Resolve the connection
      openRef.fn?.();
      await connectPromise;

      const sentMessages = (socket.send as ReturnType<typeof vi.fn>).mock.calls
        .map((args) => JSON.parse(args[0] as string) as { type: string; candidate?: { candidate: string } })
        .filter((m) => m.type === "ice-candidate");

      expect(sentMessages).toHaveLength(2);
      expect(sentMessages[0].candidate?.candidate).toContain("100.100.10.5");
      expect(sentMessages[1].candidate?.candidate).toContain("100.64.0.1");
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("connect() forwards all candidates when isTailscaleTarget=false", async () => {
    const { pc, openRef, iceCandidateRef } = makeMockPc();

    vi.stubGlobal(
      "RTCPeerConnection",
      vi.fn(function MockRTCPeerConnection(this: unknown) {
        return pc;
      }),
    );

    try {
      const mgr = new WebRtcSessionManager();
      const socket = makeMockSocket();

      const connectPromise = mgr.connect(socket, false);

      for (let i = 0; i < 5; i++) {
        await Promise.resolve();
      }

      const makeFakeCandidate = (ip: string) => ({
        candidate: `candidate:1 1 UDP 2130706431 ${ip} 51820 typ host`,
        toJSON() {
          return { candidate: this.candidate, sdpMid: "0", sdpMLineIndex: 0 };
        },
      });

      iceCandidateRef.fn?.({ candidate: makeFakeCandidate("100.100.10.5") });
      iceCandidateRef.fn?.({ candidate: makeFakeCandidate("192.168.1.1") });
      iceCandidateRef.fn?.({ candidate: makeFakeCandidate("10.0.0.1") });

      openRef.fn?.();
      await connectPromise;

      const sentMessages = (socket.send as ReturnType<typeof vi.fn>).mock.calls
        .map((args) => JSON.parse(args[0] as string) as { type: string; candidate?: { candidate: string } })
        .filter((m) => m.type === "ice-candidate");

      expect(sentMessages).toHaveLength(3);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

