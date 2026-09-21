import { describe, it, expect, vi } from "vitest";
import { isTailscaleCandidate } from "@dronelink/core-transport";
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

  it("buffers ICE candidates that arrive before the answer's remote description is set, then flushes them", async () => {
    const { pc, openRef } = makeMockPc();
    const resolveRemoteDescriptionRef: { fn: (() => void) | null } = { fn: null };
    const setRemoteDescription = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          resolveRemoteDescriptionRef.fn = resolve;
        }),
    );
    const addIceCandidate = vi.fn(async () => {});
    (pc as unknown as Record<string, unknown>).setRemoteDescription = setRemoteDescription;
    (pc as unknown as Record<string, unknown>).addIceCandidate = addIceCandidate;

    vi.stubGlobal(
      "RTCPeerConnection",
      vi.fn(function MockRTCPeerConnection(this: unknown) {
        return pc;
      }),
    );

    try {
      const mgr = new WebRtcSessionManager();
      const socket = makeMockSocket();

      const onMessageRef: { fn: ((data: string) => void) | null } = { fn: null };
      (socket.onMessage as ReturnType<typeof vi.fn>).mockImplementation((cb: (data: string) => void) => {
        onMessageRef.fn = cb;
      });

      const connectPromise = mgr.connect(socket);
      for (let i = 0; i < 5; i++) {
        await Promise.resolve();
      }

      const candidateA = { candidate: "candidate:1 1 UDP 1 100.100.10.5 51820 typ host" };
      const candidateB = { candidate: "candidate:2 1 UDP 1 100.100.10.6 51820 typ host" };

      // Candidates arrive over signaling before the answer -- addIceCandidate must not
      // be called yet, since RTCPeerConnection rejects it without a remote description.
      onMessageRef.fn?.(JSON.stringify({ type: "ice-candidate", candidate: candidateA }));
      onMessageRef.fn?.(JSON.stringify({ type: "ice-candidate", candidate: candidateB }));
      expect(addIceCandidate).not.toHaveBeenCalled();

      // The answer arrives and setRemoteDescription resolves -- buffered candidates
      // should now flush in order.
      onMessageRef.fn?.(JSON.stringify({ type: "answer", sdp: "v=0\r\n" }));
      resolveRemoteDescriptionRef.fn?.();
      for (let i = 0; i < 5; i++) {
        await Promise.resolve();
      }

      expect(addIceCandidate).toHaveBeenCalledTimes(2);
      expect(addIceCandidate).toHaveBeenNthCalledWith(1, candidateA);
      expect(addIceCandidate).toHaveBeenNthCalledWith(2, candidateB);

      // A candidate arriving after the remote description is set flushes immediately.
      const candidateC = { candidate: "candidate:3 1 UDP 1 100.100.10.7 51820 typ host" };
      onMessageRef.fn?.(JSON.stringify({ type: "ice-candidate", candidate: candidateC }));
      await Promise.resolve();
      expect(addIceCandidate).toHaveBeenCalledTimes(3);
      expect(addIceCandidate).toHaveBeenNthCalledWith(3, candidateC);

      openRef.fn?.();
      await connectPromise;
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("connect() calls addTrack() for each stream track before createOffer when localStream provided", async () => {
    const { pc, openRef } = makeMockPc();
    const addTrack = vi.fn();
    (pc as unknown as Record<string, unknown>).addTrack = addTrack;

    let createOfferCalled = false;
    const originalCreateOffer = pc.createOffer;
    pc.createOffer = vi.fn(async () => {
      createOfferCalled = true;
      return originalCreateOffer();
    });

    vi.stubGlobal(
      "RTCPeerConnection",
      vi.fn(function MockRTCPeerConnection(this: unknown) {
        return pc;
      }),
    );

    try {
      const mgr = new WebRtcSessionManager();
      const socket = makeMockSocket();

      const fakeTrack = { kind: "video", getSettings: () => ({}) } as unknown as MediaStreamTrack;
      const fakeStream = {
        getTracks: () => [fakeTrack],
        getVideoTracks: () => [fakeTrack],
      } as unknown as MediaStream;

      const connectPromise = mgr.connect(socket, false, fakeStream);

      for (let i = 0; i < 5; i++) {
        await Promise.resolve();
      }

      openRef.fn?.();
      await connectPromise;

      expect(addTrack).toHaveBeenCalledOnce();
      expect(addTrack).toHaveBeenCalledWith(fakeTrack, fakeStream);
      expect(createOfferCalled).toBe(true);
      // addTrack must have been called before createOffer
      const addTrackOrder = addTrack.mock.invocationCallOrder[0];
      const createOfferOrder = (pc.createOffer as ReturnType<typeof vi.fn>).mock.invocationCallOrder[0];
      expect(addTrackOrder).toBeLessThan(createOfferOrder);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

describe("WebRtcSessionManager — offer video dimensions", () => {
  it("connect() includes videoWidth/videoHeight in offer when localStream has a video track with settings", async () => {
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

      const fakeTrack = {
        kind: "video",
        getSettings: () => ({ width: 1280, height: 720 }),
      } as unknown as MediaStreamTrack;
      const fakeStream = {
        getTracks: () => [fakeTrack],
        getVideoTracks: () => [fakeTrack],
      } as unknown as MediaStream;
      (pc as unknown as Record<string, unknown>).addTrack = vi.fn();

      const connectPromise = mgr.connect(socket, false, fakeStream);

      for (let i = 0; i < 5; i++) {
        await Promise.resolve();
      }

      openRef.fn?.();
      await connectPromise;

      const offerMsg = (socket.send as ReturnType<typeof vi.fn>).mock.calls
        .map((args) => JSON.parse(args[0] as string) as Record<string, unknown>)
        .find((m) => m.type === "offer");

      expect(offerMsg).toBeDefined();
      expect(offerMsg?.videoWidth).toBe(1280);
      expect(offerMsg?.videoHeight).toBe(720);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("connect() omits videoWidth/videoHeight when no localStream is provided", async () => {
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

      for (let i = 0; i < 5; i++) {
        await Promise.resolve();
      }

      openRef.fn?.();
      await connectPromise;

      const offerMsg = (socket.send as ReturnType<typeof vi.fn>).mock.calls
        .map((args) => JSON.parse(args[0] as string) as Record<string, unknown>)
        .find((m) => m.type === "offer");

      expect(offerMsg).toBeDefined();
      expect(offerMsg).not.toHaveProperty("videoWidth");
      expect(offerMsg).not.toHaveProperty("videoHeight");
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

describe("WebRtcSessionManager — getConnectionMetrics", () => {
  it("returns null when there is no active connection", async () => {
    const mgr = new WebRtcSessionManager();
    await expect(mgr.getConnectionMetrics()).resolves.toBeNull();
  });

  it("aggregates RTT and byte counters from the stats report after connecting", async () => {
    const { pc, openRef } = makeMockPc();

    const statsRows = [
      { type: "candidate-pair", state: "succeeded", currentRoundTripTime: 0.048 },
      { type: "outbound-rtp", bytesSent: 1000 },
      { type: "inbound-rtp", bytesReceived: 500 },
      { type: "data-channel", bytesSent: 200, bytesReceived: 100 },
      // Ignored: not the active pair.
      { type: "candidate-pair", state: "failed", currentRoundTripTime: 9 },
    ];
    (pc as unknown as Record<string, unknown>).getStats = vi.fn(async () => ({
      forEach: (cb: (stat: unknown) => void) => statsRows.forEach(cb),
    }));

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
      for (let i = 0; i < 5; i++) {
        await Promise.resolve();
      }
      openRef.fn?.();
      await connectPromise;

      const metrics = await mgr.getConnectionMetrics();
      expect(metrics).toEqual({ rttMs: 48, bytesSent: 1200, bytesReceived: 600 });
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

describe("WebRtcSessionManager — replaceVideoTrack", () => {
  it("throws when no video was bound at connect() time", async () => {
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
      for (let i = 0; i < 5; i++) {
        await Promise.resolve();
      }
      openRef.fn?.();
      await connectPromise;

      const newTrack = {} as MediaStreamTrack;
      await expect(mgr.replaceVideoTrack(newTrack)).rejects.toThrow(
        "No active video sender to replace",
      );
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("calls replaceTrack() on the sender returned by addTrack() for the video track", async () => {
    const { pc, openRef } = makeMockPc();
    const replaceTrack = vi.fn(async () => {});
    const videoSender = { replaceTrack };
    const audioSender = { replaceTrack: vi.fn(async () => {}) };
    const addTrack = vi.fn((track: MediaStreamTrack) =>
      track.kind === "video" ? videoSender : audioSender,
    );
    (pc as unknown as Record<string, unknown>).addTrack = addTrack;

    vi.stubGlobal(
      "RTCPeerConnection",
      vi.fn(function MockRTCPeerConnection(this: unknown) {
        return pc;
      }),
    );

    try {
      const mgr = new WebRtcSessionManager();
      const socket = makeMockSocket();

      const videoTrack = { kind: "video", getSettings: () => ({}) } as unknown as MediaStreamTrack;
      const audioTrack = { kind: "audio", getSettings: () => ({}) } as unknown as MediaStreamTrack;
      const fakeStream = {
        getTracks: () => [videoTrack, audioTrack],
        getVideoTracks: () => [videoTrack],
      } as unknown as MediaStream;

      const connectPromise = mgr.connect(socket, false, fakeStream);
      for (let i = 0; i < 5; i++) {
        await Promise.resolve();
      }
      openRef.fn?.();
      await connectPromise;

      const newTrack = { kind: "video" } as unknown as MediaStreamTrack;
      await mgr.replaceVideoTrack(newTrack);

      expect(replaceTrack).toHaveBeenCalledOnce();
      expect(replaceTrack).toHaveBeenCalledWith(newTrack);
      expect(audioSender.replaceTrack).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("rejects after disconnect() clears the sender", async () => {
    const { pc, dc, openRef } = makeMockPc();
    (dc as unknown as Record<string, unknown>).close = vi.fn();
    const videoSender = { replaceTrack: vi.fn(async () => {}) };
    (pc as unknown as Record<string, unknown>).addTrack = vi.fn(() => videoSender);

    vi.stubGlobal(
      "RTCPeerConnection",
      vi.fn(function MockRTCPeerConnection(this: unknown) {
        return pc;
      }),
    );

    try {
      const mgr = new WebRtcSessionManager();
      const socket = makeMockSocket();

      const videoTrack = { kind: "video", getSettings: () => ({}) } as unknown as MediaStreamTrack;
      const fakeStream = {
        getTracks: () => [videoTrack],
        getVideoTracks: () => [videoTrack],
      } as unknown as MediaStream;

      const connectPromise = mgr.connect(socket, false, fakeStream);
      for (let i = 0; i < 5; i++) {
        await Promise.resolve();
      }
      openRef.fn?.();
      await connectPromise;

      mgr.disconnect();

      await expect(mgr.replaceVideoTrack({} as MediaStreamTrack)).rejects.toThrow(
        "No active video sender to replace",
      );
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

describe("WebRtcSessionManager — addVideoTrack", () => {
  it("throws when not connected", async () => {
    const mgr = new WebRtcSessionManager();
    await expect(
      mgr.addVideoTrack({} as MediaStreamTrack, {} as MediaStream),
    ).rejects.toThrow("session is not connected");
  });

  it("throws when a video track is already active (use replaceVideoTrack instead)", async () => {
    const { pc, openRef } = makeMockPc();
    (pc as unknown as Record<string, unknown>).addTrack = vi.fn(() => ({ replaceTrack: vi.fn() }));

    vi.stubGlobal(
      "RTCPeerConnection",
      vi.fn(function MockRTCPeerConnection(this: unknown) {
        return pc;
      }),
    );

    try {
      const mgr = new WebRtcSessionManager();
      const socket = makeMockSocket();

      const videoTrack = { kind: "video", getSettings: () => ({}) } as unknown as MediaStreamTrack;
      const fakeStream = {
        getTracks: () => [videoTrack],
        getVideoTracks: () => [videoTrack],
      } as unknown as MediaStream;

      const connectPromise = mgr.connect(socket, false, fakeStream);
      for (let i = 0; i < 5; i++) await Promise.resolve();
      openRef.fn?.();
      await connectPromise;

      expect(mgr.hasVideo).toBe(true);
      await expect(mgr.addVideoTrack(videoTrack, fakeStream)).rejects.toThrow(
        "Video track already active",
      );
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("sends a renegotiation offer with video dimensions and resolves once the answer arrives", async () => {
    const { pc, openRef } = makeMockPc();
    const addTrack = vi.fn(() => ({ replaceTrack: vi.fn() }));
    (pc as unknown as Record<string, unknown>).addTrack = addTrack;
    (pc as unknown as Record<string, unknown>).setRemoteDescription = vi.fn(async () => {});

    vi.stubGlobal(
      "RTCPeerConnection",
      vi.fn(function MockRTCPeerConnection(this: unknown) {
        return pc;
      }),
    );

    try {
      const mgr = new WebRtcSessionManager();
      const socket = makeMockSocket();
      const onMessageRef: { fn: ((data: string) => void) | null } = { fn: null };
      (socket.onMessage as ReturnType<typeof vi.fn>).mockImplementation((cb: (data: string) => void) => {
        onMessageRef.fn = cb;
      });

      // Connects data-only -- no localStream passed.
      const connectPromise = mgr.connect(socket);
      for (let i = 0; i < 5; i++) await Promise.resolve();
      openRef.fn?.();
      await connectPromise;
      expect(mgr.hasVideo).toBe(false);

      const newTrack = {
        kind: "video",
        getSettings: () => ({ width: 640, height: 480 }),
      } as unknown as MediaStreamTrack;
      const newStream = {
        getTracks: () => [newTrack],
        getVideoTracks: () => [newTrack],
      } as unknown as MediaStream;

      const addPromise = mgr.addVideoTrack(newTrack, newStream);
      for (let i = 0; i < 5; i++) await Promise.resolve();

      expect(addTrack).toHaveBeenCalledWith(newTrack, newStream);
      expect(mgr.hasVideo).toBe(true);

      const offerMsg = (socket.send as ReturnType<typeof vi.fn>).mock.calls
        .map((args) => JSON.parse(args[0] as string) as Record<string, unknown>)
        .find((m) => m.type === "offer" && m.videoWidth === 640);
      expect(offerMsg).toBeDefined();
      expect(offerMsg?.videoHeight).toBe(480);

      // The renegotiation answer flows through the same onMessage handler as the
      // original connect() answer.
      onMessageRef.fn?.(JSON.stringify({ type: "answer", sdp: "v=0\r\n" }));
      await addPromise;
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("rolls back the sender and rejects if no answer arrives before the timeout", async () => {
    vi.useFakeTimers();
    const { pc, openRef } = makeMockPc();
    const videoSender = { replaceTrack: vi.fn() };
    const addTrack = vi.fn(() => videoSender);
    const removeTrack = vi.fn();
    (pc as unknown as Record<string, unknown>).addTrack = addTrack;
    (pc as unknown as Record<string, unknown>).removeTrack = removeTrack;

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
      for (let i = 0; i < 5; i++) await Promise.resolve();
      openRef.fn?.();
      await connectPromise;

      const newTrack = { kind: "video", getSettings: () => ({}) } as unknown as MediaStreamTrack;
      const newStream = {
        getTracks: () => [newTrack],
        getVideoTracks: () => [newTrack],
      } as unknown as MediaStream;

      const addPromise = mgr.addVideoTrack(newTrack, newStream);
      for (let i = 0; i < 5; i++) await Promise.resolve();

      const assertion = expect(addPromise).rejects.toThrow("timed out");
      await vi.advanceTimersByTimeAsync(200);
      await assertion;

      expect(removeTrack).toHaveBeenCalledWith(videoSender);
      expect(mgr.hasVideo).toBe(false);
    } finally {
      vi.useRealTimers();
      vi.unstubAllGlobals();
    }
  });
});

describe("WebRtcSessionManager — video quality control", () => {
  function makeVideoSender() {
    let encodings: RTCRtpEncodingParameters[] = [{}];
    return {
      replaceTrack: vi.fn(async () => {}),
      getParameters: vi.fn(() => ({ encodings })),
      setParameters: vi.fn(async (params: { encodings: RTCRtpEncodingParameters[] }) => {
        encodings = params.encodings;
      }),
    };
  }

  function sentVideoControlStates(socket: PairingSocket): Array<Record<string, unknown>> {
    return (socket.send as ReturnType<typeof vi.fn>).mock.calls
      .map((args) => JSON.parse(args[0] as string) as Record<string, unknown>)
      .filter((m) => m.type === "video-control-state");
  }

  async function connectWithVideo(pc: unknown, openRef: { fn: (() => void) | null }) {
    const mgr = new WebRtcSessionManager();
    const socket = makeMockSocket();
    const onMessageRef: { fn: ((data: string) => void) | null } = { fn: null };
    (socket.onMessage as ReturnType<typeof vi.fn>).mockImplementation((cb: (data: string) => void) => {
      onMessageRef.fn = cb;
    });

    const videoTrack = { kind: "video", getSettings: () => ({}) } as unknown as MediaStreamTrack;
    const fakeStream = {
      getTracks: () => [videoTrack],
      getVideoTracks: () => [videoTrack],
    } as unknown as MediaStream;

    const connectPromise = mgr.connect(socket, false, fakeStream);
    for (let i = 0; i < 5; i++) await Promise.resolve();
    openRef.fn?.();
    await connectPromise;

    return { mgr, socket, onMessageRef, videoTrack };
  }

  it("is a no-op on the (nonexistent) sender when no video track is bound, but still acks", async () => {
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
      const onMessageRef: { fn: ((data: string) => void) | null } = { fn: null };
      (socket.onMessage as ReturnType<typeof vi.fn>).mockImplementation((cb: (data: string) => void) => {
        onMessageRef.fn = cb;
      });

      // Connects data-only -- no video sender is bound.
      const connectPromise = mgr.connect(socket);
      for (let i = 0; i < 5; i++) await Promise.resolve();
      openRef.fn?.();
      await connectPromise;

      expect(() =>
        onMessageRef.fn?.(
          JSON.stringify({ type: "video-control-request", control: "quality", preset: "low" }),
        ),
      ).not.toThrow();
      await Promise.resolve();
      await Promise.resolve();
      expect(sentVideoControlStates(socket)).toContainEqual({
        type: "video-control-state",
        control: "quality",
        preset: "low",
        videoActive: true,
      });
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("'high' sets maxBitrate/scaleResolutionDownBy/maxFramerate and acks with videoActive: true", async () => {
    const { pc, openRef } = makeMockPc();
    const sender = makeVideoSender();
    (pc as unknown as Record<string, unknown>).addTrack = vi.fn(() => sender);

    vi.stubGlobal(
      "RTCPeerConnection",
      vi.fn(function MockRTCPeerConnection(this: unknown) {
        return pc;
      }),
    );

    try {
      const { onMessageRef, socket } = await connectWithVideo(pc, openRef);

      onMessageRef.fn?.(
        JSON.stringify({ type: "video-control-request", control: "quality", preset: "high" }),
      );

      expect(sender.setParameters).toHaveBeenCalledWith({
        encodings: [{ maxBitrate: 2_000_000, scaleResolutionDownBy: 1, maxFramerate: 30 }],
      });
      await Promise.resolve();
      await Promise.resolve();
      expect(sentVideoControlStates(socket)).toContainEqual({
        type: "video-control-state",
        control: "quality",
        preset: "high",
        videoActive: true,
      });
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("'low' sets the reduced encoding caps", async () => {
    const { pc, openRef } = makeMockPc();
    const sender = makeVideoSender();
    (pc as unknown as Record<string, unknown>).addTrack = vi.fn(() => sender);

    vi.stubGlobal(
      "RTCPeerConnection",
      vi.fn(function MockRTCPeerConnection(this: unknown) {
        return pc;
      }),
    );

    try {
      const { onMessageRef } = await connectWithVideo(pc, openRef);

      onMessageRef.fn?.(
        JSON.stringify({ type: "video-control-request", control: "quality", preset: "low" }),
      );

      expect(sender.setParameters).toHaveBeenCalledWith({
        encodings: [{ maxBitrate: 350_000, scaleResolutionDownBy: 2, maxFramerate: 15 }],
      });
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("'auto' clears previously-set encoding caps", async () => {
    const { pc, openRef } = makeMockPc();
    const sender = makeVideoSender();
    (pc as unknown as Record<string, unknown>).addTrack = vi.fn(() => sender);

    vi.stubGlobal(
      "RTCPeerConnection",
      vi.fn(function MockRTCPeerConnection(this: unknown) {
        return pc;
      }),
    );

    try {
      const { onMessageRef } = await connectWithVideo(pc, openRef);

      onMessageRef.fn?.(
        JSON.stringify({ type: "video-control-request", control: "quality", preset: "low" }),
      );
      onMessageRef.fn?.(
        JSON.stringify({ type: "video-control-request", control: "quality", preset: "auto" }),
      );

      expect(sender.setParameters).toHaveBeenLastCalledWith({ encodings: [{}] });
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("'data-only' replaces the sender's track with null and does not touch setParameters, acking videoActive: false", async () => {
    const { pc, openRef } = makeMockPc();
    const sender = makeVideoSender();
    (pc as unknown as Record<string, unknown>).addTrack = vi.fn(() => sender);

    vi.stubGlobal(
      "RTCPeerConnection",
      vi.fn(function MockRTCPeerConnection(this: unknown) {
        return pc;
      }),
    );

    try {
      const { onMessageRef, socket } = await connectWithVideo(pc, openRef);

      onMessageRef.fn?.(
        JSON.stringify({ type: "video-control-request", control: "quality", preset: "data-only" }),
      );

      expect(sender.replaceTrack).toHaveBeenCalledWith(null);
      expect(sender.setParameters).not.toHaveBeenCalled();
      await Promise.resolve();
      await Promise.resolve();
      expect(sentVideoControlStates(socket)).toContainEqual({
        type: "video-control-state",
        control: "quality",
        preset: "data-only",
        videoActive: false,
      });
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("leaving data-only restores the original track before applying the new preset", async () => {
    const { pc, openRef } = makeMockPc();
    const sender = makeVideoSender();
    (pc as unknown as Record<string, unknown>).addTrack = vi.fn(() => sender);

    vi.stubGlobal(
      "RTCPeerConnection",
      vi.fn(function MockRTCPeerConnection(this: unknown) {
        return pc;
      }),
    );

    try {
      const { onMessageRef, videoTrack } = await connectWithVideo(pc, openRef);

      onMessageRef.fn?.(
        JSON.stringify({ type: "video-control-request", control: "quality", preset: "data-only" }),
      );
      onMessageRef.fn?.(
        JSON.stringify({ type: "video-control-request", control: "quality", preset: "auto" }),
      );

      expect(sender.replaceTrack).toHaveBeenNthCalledWith(1, null);
      expect(sender.replaceTrack).toHaveBeenNthCalledWith(2, videoTrack);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("ignores an unrecognized control value without throwing", async () => {
    const { pc, openRef } = makeMockPc();
    const sender = makeVideoSender();
    (pc as unknown as Record<string, unknown>).addTrack = vi.fn(() => sender);

    vi.stubGlobal(
      "RTCPeerConnection",
      vi.fn(function MockRTCPeerConnection(this: unknown) {
        return pc;
      }),
    );

    try {
      const { onMessageRef } = await connectWithVideo(pc, openRef);

      expect(() =>
        onMessageRef.fn?.(
          JSON.stringify({ type: "video-control-request", control: "zoom", level: 2 }),
        ),
      ).not.toThrow();
      expect(sender.setParameters).not.toHaveBeenCalled();
      expect(sender.replaceTrack).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("replaceVideoTrack() while in data-only mode updates the stored track but does not resume sending", async () => {
    const { pc, openRef } = makeMockPc();
    const sender = makeVideoSender();
    (pc as unknown as Record<string, unknown>).addTrack = vi.fn(() => sender);

    vi.stubGlobal(
      "RTCPeerConnection",
      vi.fn(function MockRTCPeerConnection(this: unknown) {
        return pc;
      }),
    );

    try {
      const { mgr, onMessageRef } = await connectWithVideo(pc, openRef);

      onMessageRef.fn?.(
        JSON.stringify({ type: "video-control-request", control: "quality", preset: "data-only" }),
      );
      sender.replaceTrack.mockClear();

      const newTrack = { kind: "video" } as unknown as MediaStreamTrack;
      await mgr.replaceVideoTrack(newTrack);

      expect(sender.replaceTrack).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

describe("WebRtcSessionManager — camera-source control", () => {
  function sentVideoControlStates(socket: PairingSocket): Array<Record<string, unknown>> {
    return (socket.send as ReturnType<typeof vi.fn>).mock.calls
      .map((args) => JSON.parse(args[0] as string) as Record<string, unknown>)
      .filter((m) => m.type === "video-control-state");
  }

  async function connectedManager(): Promise<{
    mgr: WebRtcSessionManager;
    socket: PairingSocket;
    onMessageRef: { fn: ((data: string) => void) | null };
  }> {
    const { pc, openRef } = makeMockPc();
    vi.stubGlobal(
      "RTCPeerConnection",
      vi.fn(function MockRTCPeerConnection(this: unknown) {
        return pc;
      }),
    );

    const mgr = new WebRtcSessionManager();
    const socket = makeMockSocket();
    const onMessageRef: { fn: ((data: string) => void) | null } = { fn: null };
    (socket.onMessage as ReturnType<typeof vi.fn>).mockImplementation((cb: (data: string) => void) => {
      onMessageRef.fn = cb;
    });

    const connectPromise = mgr.connect(socket);
    for (let i = 0; i < 5; i++) await Promise.resolve();
    openRef.fn?.();
    await connectPromise;

    return { mgr, socket, onMessageRef };
  }

  it("calls the registered handler with the requested deviceId and acks ok: true", async () => {
    const { mgr, socket, onMessageRef } = await connectedManager();
    const handler = vi.fn(async () => {});
    mgr.setCameraSourceHandler(handler);

    onMessageRef.fn?.(
      JSON.stringify({ type: "video-control-request", control: "camera-source", deviceId: "cam-2" }),
    );
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    expect(handler).toHaveBeenCalledWith("cam-2");
    expect(sentVideoControlStates(socket)).toContainEqual({
      type: "video-control-state",
      control: "camera-source",
      deviceId: "cam-2",
      ok: true,
    });
  });

  it("acks ok: false with the rejection message when the handler throws", async () => {
    const { mgr, socket, onMessageRef } = await connectedManager();
    mgr.setCameraSourceHandler(async () => {
      throw new Error("camera busy");
    });

    onMessageRef.fn?.(
      JSON.stringify({ type: "video-control-request", control: "camera-source", deviceId: "cam-3" }),
    );
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    expect(sentVideoControlStates(socket)).toContainEqual({
      type: "video-control-state",
      control: "camera-source",
      deviceId: "cam-3",
      ok: false,
      error: "camera busy",
    });
  });

  it("acks ok: false when no camera source handler has been registered", async () => {
    const { socket, onMessageRef } = await connectedManager();

    onMessageRef.fn?.(
      JSON.stringify({ type: "video-control-request", control: "camera-source", deviceId: "cam-1" }),
    );
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    expect(sentVideoControlStates(socket)).toContainEqual({
      type: "video-control-state",
      control: "camera-source",
      deviceId: "cam-1",
      ok: false,
      error: "No camera source handler registered.",
    });
  });

  it("ignores a camera-source request with an empty deviceId, without calling the handler", async () => {
    const { mgr, socket, onMessageRef } = await connectedManager();
    const handler = vi.fn(async () => {});
    mgr.setCameraSourceHandler(handler);

    onMessageRef.fn?.(JSON.stringify({ type: "video-control-request", control: "camera-source", deviceId: "" }));
    await Promise.resolve();
    await Promise.resolve();

    expect(handler).not.toHaveBeenCalled();
    expect(sentVideoControlStates(socket)).toHaveLength(0);
  });

  it("publishCameraSources() sends a camera-source-list state over the socket", async () => {
    const { mgr, socket } = await connectedManager();

    mgr.publishCameraSources([{ deviceId: "cam-1", label: "Front" }], "cam-1");

    expect(socket.send).toHaveBeenCalledWith(
      JSON.stringify({
        type: "video-control-state",
        control: "camera-source-list",
        devices: [{ deviceId: "cam-1", label: "Front" }],
        activeDeviceId: "cam-1",
      }),
    );
  });

  it("publishCameraSources() is a no-op before connect() has set a socket", () => {
    const mgr = new WebRtcSessionManager();
    expect(() => mgr.publishCameraSources([], null)).not.toThrow();
  });

  it("publishAirStatus() sends an air-status message with the battery over the socket", async () => {
    const { mgr, socket } = await connectedManager();

    mgr.publishAirStatus({ battery: { percent: 42, charging: false } });

    expect(socket.send).toHaveBeenCalledWith(
      JSON.stringify({ type: "air-status", battery: { percent: 42, charging: false } }),
    );
  });

  it("publishAirStatus() includes session data usage when given", async () => {
    const { mgr, socket } = await connectedManager();

    mgr.publishAirStatus({ dataUsage: { txBytes: 1500, rxBytes: 300 } });

    expect(socket.send).toHaveBeenCalledWith(
      JSON.stringify({ type: "air-status", dataUsage: { txBytes: 1500, rxBytes: 300 } }),
    );
  });

  it("publishAirStatus() sends a bare air-status when no battery reading is available", async () => {
    const { mgr, socket } = await connectedManager();

    mgr.publishAirStatus({});

    expect(socket.send).toHaveBeenCalledWith(JSON.stringify({ type: "air-status" }));
  });

  it("publishAirStatus() is a no-op before connect() has set a socket", () => {
    const mgr = new WebRtcSessionManager();
    expect(() => mgr.publishAirStatus({ battery: { percent: 1, charging: false } })).not.toThrow();
  });
});

describe("WebRtcSessionManager — flip control", () => {
  function sentVideoControlStates(socket: PairingSocket): Array<Record<string, unknown>> {
    return (socket.send as ReturnType<typeof vi.fn>).mock.calls
      .map((args) => JSON.parse(args[0] as string) as Record<string, unknown>)
      .filter((m) => m.type === "video-control-state");
  }

  async function connectedManager(): Promise<{
    mgr: WebRtcSessionManager;
    socket: PairingSocket;
    onMessageRef: { fn: ((data: string) => void) | null };
  }> {
    const { pc, openRef } = makeMockPc();
    vi.stubGlobal(
      "RTCPeerConnection",
      vi.fn(function MockRTCPeerConnection(this: unknown) {
        return pc;
      }),
    );

    const mgr = new WebRtcSessionManager();
    const socket = makeMockSocket();
    const onMessageRef: { fn: ((data: string) => void) | null } = { fn: null };
    (socket.onMessage as ReturnType<typeof vi.fn>).mockImplementation((cb: (data: string) => void) => {
      onMessageRef.fn = cb;
    });

    const connectPromise = mgr.connect(socket);
    for (let i = 0; i < 5; i++) await Promise.resolve();
    openRef.fn?.();
    await connectPromise;

    return { mgr, socket, onMessageRef };
  }

  it("calls the registered handler with the requested flip state and acks ok: true", async () => {
    const { mgr, socket, onMessageRef } = await connectedManager();
    const handler = vi.fn(async () => {});
    mgr.setFlipHandler(handler);

    onMessageRef.fn?.(
      JSON.stringify({ type: "video-control-request", control: "flip", horizontal: true, vertical: false }),
    );
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    expect(handler).toHaveBeenCalledWith({ horizontal: true, vertical: false });
    expect(sentVideoControlStates(socket)).toContainEqual({
      type: "video-control-state",
      control: "flip",
      horizontal: true,
      vertical: false,
      ok: true,
    });
  });

  it("acks ok: false with the rejection message when the handler throws", async () => {
    const { mgr, socket, onMessageRef } = await connectedManager();
    mgr.setFlipHandler(async () => {
      throw new Error("no video track bound");
    });

    onMessageRef.fn?.(
      JSON.stringify({ type: "video-control-request", control: "flip", horizontal: false, vertical: true }),
    );
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    expect(sentVideoControlStates(socket)).toContainEqual({
      type: "video-control-state",
      control: "flip",
      horizontal: false,
      vertical: true,
      ok: false,
      error: "no video track bound",
    });
  });

  it("acks ok: false when no flip handler has been registered", async () => {
    const { socket, onMessageRef } = await connectedManager();

    onMessageRef.fn?.(
      JSON.stringify({ type: "video-control-request", control: "flip", horizontal: true, vertical: true }),
    );
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    expect(sentVideoControlStates(socket)).toContainEqual({
      type: "video-control-state",
      control: "flip",
      horizontal: true,
      vertical: true,
      ok: false,
      error: "No flip handler registered.",
    });
  });

  it("ignores a flip request with non-boolean fields, without calling the handler", async () => {
    const { mgr, socket, onMessageRef } = await connectedManager();
    const handler = vi.fn(async () => {});
    mgr.setFlipHandler(handler);

    onMessageRef.fn?.(
      JSON.stringify({ type: "video-control-request", control: "flip", horizontal: "yes", vertical: false }),
    );
    await Promise.resolve();
    await Promise.resolve();

    expect(handler).not.toHaveBeenCalled();
    expect(sentVideoControlStates(socket)).toHaveLength(0);
  });
});

describe("WebRtcSessionManager — rotate control", () => {
  function sentVideoControlStates(socket: PairingSocket): Array<Record<string, unknown>> {
    return (socket.send as ReturnType<typeof vi.fn>).mock.calls
      .map((args) => JSON.parse(args[0] as string) as Record<string, unknown>)
      .filter((m) => m.type === "video-control-state");
  }

  async function connectedManager(): Promise<{
    mgr: WebRtcSessionManager;
    socket: PairingSocket;
    onMessageRef: { fn: ((data: string) => void) | null };
  }> {
    const { pc, openRef } = makeMockPc();
    vi.stubGlobal(
      "RTCPeerConnection",
      vi.fn(function MockRTCPeerConnection(this: unknown) {
        return pc;
      }),
    );

    const mgr = new WebRtcSessionManager();
    const socket = makeMockSocket();
    const onMessageRef: { fn: ((data: string) => void) | null } = { fn: null };
    (socket.onMessage as ReturnType<typeof vi.fn>).mockImplementation((cb: (data: string) => void) => {
      onMessageRef.fn = cb;
    });

    const connectPromise = mgr.connect(socket);
    for (let i = 0; i < 5; i++) await Promise.resolve();
    openRef.fn?.();
    await connectPromise;

    return { mgr, socket, onMessageRef };
  }

  it("calls the registered handler with the requested degrees and acks ok: true", async () => {
    const { mgr, socket, onMessageRef } = await connectedManager();
    const handler = vi.fn(async () => {});
    mgr.setRotateHandler(handler);

    onMessageRef.fn?.(JSON.stringify({ type: "video-control-request", control: "rotate", degrees: 90 }));
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    expect(handler).toHaveBeenCalledWith(90);
    expect(sentVideoControlStates(socket)).toContainEqual({
      type: "video-control-state",
      control: "rotate",
      degrees: 90,
      ok: true,
    });
  });

  it("acks ok: false with the rejection message when the handler throws", async () => {
    const { mgr, socket, onMessageRef } = await connectedManager();
    mgr.setRotateHandler(async () => {
      throw new Error("no video track bound");
    });

    onMessageRef.fn?.(JSON.stringify({ type: "video-control-request", control: "rotate", degrees: 270 }));
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    expect(sentVideoControlStates(socket)).toContainEqual({
      type: "video-control-state",
      control: "rotate",
      degrees: 270,
      ok: false,
      error: "no video track bound",
    });
  });

  it("acks ok: false when no rotate handler has been registered", async () => {
    const { socket, onMessageRef } = await connectedManager();

    onMessageRef.fn?.(JSON.stringify({ type: "video-control-request", control: "rotate", degrees: 180 }));
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    expect(sentVideoControlStates(socket)).toContainEqual({
      type: "video-control-state",
      control: "rotate",
      degrees: 180,
      ok: false,
      error: "No rotate handler registered.",
    });
  });

  it("ignores a rotate request with degrees outside the 90-degree steps, without calling the handler", async () => {
    const { mgr, socket, onMessageRef } = await connectedManager();
    const handler = vi.fn(async () => {});
    mgr.setRotateHandler(handler);

    onMessageRef.fn?.(JSON.stringify({ type: "video-control-request", control: "rotate", degrees: 45 }));
    await Promise.resolve();
    await Promise.resolve();

    expect(handler).not.toHaveBeenCalled();
    expect(sentVideoControlStates(socket)).toHaveLength(0);
  });
});

describe("WebRtcSessionManager — disconnect", () => {
  it("is a no-op when never connected", () => {
    const mgr = new WebRtcSessionManager();
    expect(() => mgr.disconnect()).not.toThrow();
    expect(mgr.state).toBe("IDLE");
  });

  it("closes the data channel and peer connection, and resets state to IDLE", async () => {
    const { pc, dc, openRef } = makeMockPc();
    (dc as unknown as Record<string, unknown>).close = vi.fn();

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
      for (let i = 0; i < 5; i++) {
        await Promise.resolve();
      }
      openRef.fn?.();
      await connectPromise;

      mgr.disconnect();

      expect((dc as unknown as { close: ReturnType<typeof vi.fn> }).close).toHaveBeenCalledOnce();
      expect(pc.close).toHaveBeenCalledOnce();
      expect(mgr.state).toBe("IDLE");
      expect(() => mgr.sendBytes(new Uint8Array([1]))).toThrow();
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
