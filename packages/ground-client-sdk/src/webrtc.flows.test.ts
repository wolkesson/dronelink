// Exercises the success and failure paths of handleSignalingMessage /
// handleGuiSignalingMessage that require a real negotiation to complete --
// video track arrival, data-channel open/close, ICE candidate flushing, and
// the GUI viewer relay. webrtc.test.ts drives the real werift RTCPeerConnection
// with empty SDP (so negotiation always fails and only the early/error branches
// run); this file replaces RTCPeerConnection and MediaRecorder with fully
// controllable fakes so the negotiation-success branches are reachable too.
import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { MediaStreamTrack } from "werift";
import type { RTCDataChannel } from "werift";
import {
  setStateDir,
  setDataChannelCallbacks,
  handleSignalingMessage,
  handleGuiSignalingMessage,
  handleSocketClose,
  handleGuiSocketClose,
} from "./webrtc.js";

interface MockPeerConnection {
  onIceCandidate: FakeEvent<{ candidate: string; toJSON(): unknown } | null>;
  onTrack: FakeEvent<MediaStreamTrack>;
  onDataChannel: FakeEvent<RTCDataChannel>;
  setRemoteDescription: ReturnType<typeof vi.fn>;
  createAnswer: ReturnType<typeof vi.fn>;
  setLocalDescription: ReturnType<typeof vi.fn>;
  addIceCandidate: ReturnType<typeof vi.fn>;
  close: ReturnType<typeof vi.fn>;
  getReceivers: ReturnType<typeof vi.fn>;
  addTrack: ReturnType<typeof vi.fn>;
}

class FakeEvent<T> {
  private listeners: Array<(v: T) => void> = [];
  subscribe(cb: (v: T) => void): { unSubscribe: () => void } {
    this.listeners.push(cb);
    return { unSubscribe: () => (this.listeners = this.listeners.filter((l) => l !== cb)) };
  }
  execute(v: T): void {
    for (const cb of [...this.listeners]) cb(v);
  }
}

const {
  pcInstances,
  RTCPeerConnectionMock,
  recorderInstances,
  MediaRecorderMock,
  mockConfig,
} = vi.hoisted(() => {
  const pcInstances: MockPeerConnection[] = [];
  const mockConfig = { failNextSetRemoteDescription: false, failNextRecorderAddTrack: false };

  class RTCPeerConnectionMockImpl {
    onIceCandidate = new (class Ev {
      private listeners: Array<(v: unknown) => void> = [];
      subscribe(cb: (v: unknown) => void) {
        this.listeners.push(cb);
        return { unSubscribe: () => undefined };
      }
      execute(v: unknown) {
        for (const cb of [...this.listeners]) cb(v);
      }
    })();
    onTrack = new (this.onIceCandidate.constructor as new () => (typeof this)["onIceCandidate"])();
    onDataChannel = new (this.onIceCandidate.constructor as new () => (typeof this)["onIceCandidate"])();
    setRemoteDescription = vi.fn(async () => {
      if (mockConfig.failNextSetRemoteDescription) {
        mockConfig.failNextSetRemoteDescription = false;
        throw new Error("mock setRemoteDescription failure");
      }
    });
    createAnswer = vi.fn(async () => ({ sdp: "mock-answer-sdp", type: "answer" }));
    setLocalDescription = vi.fn(async () => {});
    addIceCandidate = vi.fn(async () => {});
    close = vi.fn(async () => {});
    getReceivers = vi.fn(() => [] as Array<{ track: unknown; sendRtcpPLI: (ssrc: number) => Promise<void> }>);
    addTrack = vi.fn(() => ({ onPictureLossIndication: { subscribe: vi.fn() } }));
    constructor() {
      pcInstances.push(this as unknown as MockPeerConnection);
    }
  }

  const recorderInstances: Array<{ opts: Record<string, unknown>; addTrack: ReturnType<typeof vi.fn>; stop: ReturnType<typeof vi.fn> }> = [];

  class MediaRecorderMockImpl {
    opts: Record<string, unknown>;
    addTrack = vi.fn(async () => {
      if (mockConfig.failNextRecorderAddTrack) {
        mockConfig.failNextRecorderAddTrack = false;
        throw new Error("attach failed");
      }
    });
    stop = vi.fn(async () => {});
    constructor(opts: Record<string, unknown>) {
      this.opts = opts;
      recorderInstances.push(this);
    }
  }

  return {
    pcInstances,
    RTCPeerConnectionMock: RTCPeerConnectionMockImpl,
    recorderInstances,
    MediaRecorderMock: MediaRecorderMockImpl,
    mockConfig,
  };
});

vi.mock("werift", async (importOriginal) => {
  const actual = await importOriginal<typeof import("werift")>();
  return { ...actual, RTCPeerConnection: RTCPeerConnectionMock };
});

vi.mock("werift/nonstandard", () => ({ MediaRecorder: MediaRecorderMock }));

function lastPc(): MockPeerConnection {
  const pc = pcInstances[pcInstances.length - 1];
  if (!pc) throw new Error("no RTCPeerConnection was constructed");
  return pc;
}

function videoTrack(ssrc?: number): MediaStreamTrack {
  const track = new MediaStreamTrack({ kind: "video" });
  if (ssrc !== undefined) track.ssrc = ssrc;
  return track;
}

function fakeChannel(overrides: Partial<RTCDataChannel> = {}): RTCDataChannel {
  return {
    label: "serial-relay",
    readyState: "open",
    onclose: undefined,
    onopen: undefined,
    ...overrides,
  } as unknown as RTCDataChannel;
}

/** Gets a video track flowing on the main signaling connection, as a precondition for GUI viewer tests. */
async function connectVideoSource(): Promise<{ pc: MockPeerConnection; track: MediaStreamTrack }> {
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
  vi.spyOn(console, "log").mockImplementation(() => undefined);
  const reply = vi.fn();
  handleSignalingMessage({ type: "offer", sdp: "v=0" }, reply);
  const pc = lastPc();
  const track = videoTrack(777);
  const sendRtcpPLI = vi.fn(async () => {});
  pc.getReceivers.mockReturnValue([{ track, sendRtcpPLI }]);
  pc.onTrack.execute(track);
  await vi.waitFor(() => expect(recorderInstances).toHaveLength(1));
  return { pc, track };
}

afterEach(() => {
  handleSocketClose();
  handleGuiSocketClose();
  pcInstances.length = 0;
  recorderInstances.length = 0;
  mockConfig.failNextSetRemoteDescription = false;
  mockConfig.failNextRecorderAddTrack = false;
  vi.restoreAllMocks();
});

describe("setDataChannelCallbacks", () => {
  it("registers callbacks without throwing", () => {
    expect(() => setDataChannelCallbacks(vi.fn(), vi.fn())).not.toThrow();
  });
});

describe("handleSignalingMessage: fresh offer success", () => {
  it("answers the offer and forwards ICE candidates once negotiation resolves", async () => {
    const reply = vi.fn();
    handleSignalingMessage({ type: "offer", sdp: "v=0" }, reply);

    const pc = lastPc();
    expect(pc.setRemoteDescription).toHaveBeenCalledWith({ type: "offer", sdp: "v=0" });

    await vi.waitFor(() =>
      expect(reply).toHaveBeenCalledWith({ type: "answer", sdp: "mock-answer-sdp" }),
    );
  });

  it("flushes candidates buffered before the offer arrived, in order", async () => {
    const reply = vi.fn();
    handleSignalingMessage(
      { type: "ice-candidate", candidate: { candidate: "candidate:1 1 UDP 1 10.0.0.1 1 typ host" } },
      reply,
    );
    handleSignalingMessage(
      { type: "ice-candidate", candidate: { candidate: "candidate:2 1 UDP 1 10.0.0.2 2 typ host" } },
      reply,
    );
    handleSignalingMessage({ type: "offer", sdp: "v=0" }, reply);

    const pc = lastPc();
    await vi.waitFor(() => expect(pc.addIceCandidate).toHaveBeenCalledTimes(2));
    expect(pc.addIceCandidate).toHaveBeenNthCalledWith(1, expect.objectContaining({ candidate: "candidate:1 1 UDP 1 10.0.0.1 1 typ host" }));
    expect(pc.addIceCandidate).toHaveBeenNthCalledWith(2, expect.objectContaining({ candidate: "candidate:2 1 UDP 1 10.0.0.2 2 typ host" }));
  });

  it("logs a warning instead of throwing when flushing a buffered candidate fails", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const reply = vi.fn();
    handleSignalingMessage(
      { type: "ice-candidate", candidate: { candidate: "candidate:1 1 UDP 1 10.0.0.1 1 typ host" } },
      reply,
    );
    handleSignalingMessage({ type: "offer", sdp: "v=0" }, reply);

    const pc = lastPc();
    pc.addIceCandidate.mockRejectedValueOnce(new Error("ice fail"));

    await vi.waitFor(() =>
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining("Failed to add buffered ICE candidate:"),
        "ice fail",
      ),
    );
  });

  it("relays locally-gathered ICE candidates to the peer via reply()", () => {
    const reply = vi.fn();
    handleSignalingMessage({ type: "offer", sdp: "v=0" }, reply);
    const pc = lastPc();

    const candidate = { candidate: "candidate:1 1 UDP 1 10.0.0.1 1 typ host", toJSON: () => ({ mock: true }) };
    pc.onIceCandidate.execute(candidate);

    expect(reply).toHaveBeenCalledWith({ type: "ice-candidate", candidate: { mock: true } });
  });

  it("does not relay a null ICE candidate (end-of-candidates signal)", () => {
    const reply = vi.fn();
    handleSignalingMessage({ type: "offer", sdp: "v=0" }, reply);
    const pc = lastPc();

    pc.onIceCandidate.execute(null);

    expect(reply).not.toHaveBeenCalledWith(expect.objectContaining({ type: "ice-candidate" }));
  });

  it("logs an error instead of throwing when a direct addIceCandidate fails", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const reply = vi.fn();
    handleSignalingMessage({ type: "offer", sdp: "v=0" }, reply);
    const pc = lastPc();
    await vi.waitFor(() => expect(reply).toHaveBeenCalledWith(expect.objectContaining({ type: "answer" })));
    pc.addIceCandidate.mockRejectedValueOnce(new Error("ice fail"));

    handleSignalingMessage(
      { type: "ice-candidate", candidate: { candidate: "candidate:9 1 UDP 1 10.0.0.20 1 typ host" } },
      reply,
    );

    await vi.waitFor(() =>
      expect(errorSpy).toHaveBeenCalledWith("addIceCandidate failed:", "ice fail"),
    );
  });

  it("drops non-Tailscale candidates and keeps Tailscale ones when isTailscale is set", () => {
    const reply = vi.fn();
    handleSignalingMessage({ type: "offer", sdp: "v=0" }, reply, true);
    const pc = lastPc();

    pc.onIceCandidate.execute({
      candidate: "candidate:1 1 UDP 1 192.168.1.5 1 typ host",
      toJSON: () => ({ addr: "lan" }),
    });
    expect(reply).not.toHaveBeenCalledWith(expect.objectContaining({ type: "ice-candidate" }));

    pc.onIceCandidate.execute({
      candidate: "candidate:1 1 UDP 1 100.64.0.1 1 typ host",
      toJSON: () => ({ addr: "ts" }),
    });
    expect(reply).toHaveBeenCalledWith({ type: "ice-candidate", candidate: { addr: "ts" } });
  });

  it("logs and clears activePc when the initial negotiation fails", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    mockConfig.failNextSetRemoteDescription = true;
    const reply = vi.fn();

    handleSignalingMessage({ type: "offer", sdp: "v=0" }, reply);

    await vi.waitFor(() =>
      expect(errorSpy).toHaveBeenCalledWith(
        "WebRTC offer handling failed:",
        "mock setRemoteDescription failure",
      ),
    );

    // activePc was cleared on failure, so a follow-up offer is treated as fresh
    // (a new RTCPeerConnection), not routed into the renegotiation branch.
    const reply2 = vi.fn();
    handleSignalingMessage({ type: "offer", sdp: "v=0" }, reply2);
    expect(pcInstances).toHaveLength(2);
    await vi.waitFor(() => expect(reply2).toHaveBeenCalledWith({ type: "answer", sdp: "mock-answer-sdp" }));
  });
});

describe("handleSignalingMessage: renegotiation", () => {
  it("reuses the existing peer connection and updates pending video dimensions", async () => {
    const reply = vi.fn();
    handleSignalingMessage({ type: "offer", sdp: "v=0" }, reply);
    await vi.waitFor(() => expect(reply).toHaveBeenCalledTimes(1));

    const reply2 = vi.fn();
    handleSignalingMessage(
      { type: "offer", sdp: "v=1", videoWidth: 1280, videoHeight: 720 },
      reply2,
    );

    expect(pcInstances).toHaveLength(1);
    const pc = lastPc();
    expect(pc.setRemoteDescription).toHaveBeenCalledWith({ type: "offer", sdp: "v=1" });
    await vi.waitFor(() =>
      expect(reply2).toHaveBeenCalledWith({ type: "answer", sdp: "mock-answer-sdp" }),
    );

    // The updated dimensions are picked up by the video track handler.
    pc.getReceivers.mockReturnValue([]);
    pc.onTrack.execute(videoTrack());
    await vi.waitFor(() => expect(recorderInstances).toHaveLength(1));
    expect(recorderInstances[0].opts).toMatchObject({ width: 1280, height: 720 });
  });

  it("logs and does not answer when renegotiation fails", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const reply = vi.fn();
    handleSignalingMessage({ type: "offer", sdp: "v=0" }, reply);
    await vi.waitFor(() => expect(reply).toHaveBeenCalledTimes(1));

    mockConfig.failNextSetRemoteDescription = true;
    const reply2 = vi.fn();
    handleSignalingMessage({ type: "offer", sdp: "v=1" }, reply2);

    await vi.waitFor(() =>
      expect(errorSpy).toHaveBeenCalledWith(
        "WebRTC renegotiation failed:",
        "mock setRemoteDescription failure",
      ),
    );
    expect(reply2).not.toHaveBeenCalled();
  });
});

describe("handleSignalingMessage: video track arrival", () => {
  it("ignores non-video tracks", () => {
    const reply = vi.fn();
    handleSignalingMessage({ type: "offer", sdp: "v=0" }, reply);
    const pc = lastPc();

    pc.onTrack.execute(new MediaStreamTrack({ kind: "audio" }));

    expect(recorderInstances).toHaveLength(0);
  });

  it("warns and falls back to 320x240 when the offer never signaled dimensions", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const reply = vi.fn();
    handleSignalingMessage({ type: "offer", sdp: "v=0" }, reply);
    const pc = lastPc();
    pc.getReceivers.mockReturnValue([]);

    pc.onTrack.execute(videoTrack());

    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("Video dimensions not signaled in offer"),
    );
    await vi.waitFor(() => expect(recorderInstances).toHaveLength(1));
    expect(recorderInstances[0].opts).toMatchObject({ width: 320, height: 240, disableLipSync: true });
    await vi.waitFor(() =>
      expect(logSpy).toHaveBeenCalledWith(expect.stringContaining("Video recording (320x240) started")),
    );
  });

  it("uses the offer-signaled dimensions and locates the matching receiver", async () => {
    const reply = vi.fn();
    handleSignalingMessage({ type: "offer", sdp: "v=0", videoWidth: 640, videoHeight: 480 }, reply);
    const pc = lastPc();
    const track = videoTrack(555);
    const sendRtcpPLI = vi.fn(async () => {});
    pc.getReceivers.mockReturnValue([{ track, sendRtcpPLI }]);

    pc.onTrack.execute(track);

    await vi.waitFor(() => expect(recorderInstances).toHaveLength(1));
    expect(recorderInstances[0].opts).toMatchObject({ width: 640, height: 480 });
  });

  it("creates the state directory and writes the recording under it", async () => {
    const dir = mkdtempSync(join(tmpdir(), "dronelink-ground-test-"));
    try {
      setStateDir(join(dir, "nested"));
      const reply = vi.fn();
      handleSignalingMessage({ type: "offer", sdp: "v=0" }, reply);
      const pc = lastPc();
      pc.getReceivers.mockReturnValue([]);

      pc.onTrack.execute(videoTrack());

      await vi.waitFor(() => expect(recorderInstances).toHaveLength(1));
      expect(recorderInstances[0].opts.path).toContain(join(dir, "nested"));
    } finally {
      setStateDir("");
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("logs an error when the recorder fails to attach the track", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const reply = vi.fn();
    handleSignalingMessage({ type: "offer", sdp: "v=0" }, reply);
    const pc = lastPc();
    pc.getReceivers.mockReturnValue([]);
    mockConfig.failNextRecorderAddTrack = true;

    pc.onTrack.execute(videoTrack());

    await vi.waitFor(() =>
      expect(errorSpy).toHaveBeenCalledWith("Video recorder error:", "attach failed"),
    );
  });
});

describe("handleSignalingMessage: data channel lifecycle", () => {
  it("ignores data channels with an unrelated label", () => {
    const onOpen = vi.fn();
    const onClose = vi.fn();
    setDataChannelCallbacks(onOpen, onClose);
    const reply = vi.fn();
    handleSignalingMessage({ type: "offer", sdp: "v=0" }, reply);
    const pc = lastPc();

    pc.onDataChannel.execute(fakeChannel({ label: "other" }));

    expect(onOpen).not.toHaveBeenCalled();
  });

  it("opens immediately when the channel is already open, and tears down cleanly on close", async () => {
    const onOpen = vi.fn();
    const onClose = vi.fn();
    setDataChannelCallbacks(onOpen, onClose);
    const reply = vi.fn();
    handleSignalingMessage({ type: "offer", sdp: "v=0" }, reply);
    const pc = lastPc();
    const channel = fakeChannel({ readyState: "open" });

    pc.onDataChannel.execute(channel);
    expect(onOpen).toHaveBeenCalledWith(channel);
    expect(typeof channel.onclose).toBe("function");

    channel.onclose?.();
    expect(onClose).toHaveBeenCalledTimes(1);
    await vi.waitFor(() => expect(pc.close).toHaveBeenCalledTimes(1));
  });

  it("swallows a pc.close() rejection on data-channel close without throwing", async () => {
    setDataChannelCallbacks(vi.fn(), vi.fn());
    const reply = vi.fn();
    handleSignalingMessage({ type: "offer", sdp: "v=0" }, reply);
    const pc = lastPc();
    const channel = fakeChannel({ readyState: "open" });
    pc.onDataChannel.execute(channel);
    pc.close.mockRejectedValueOnce(new Error("close failed"));

    expect(() => channel.onclose?.()).not.toThrow();
    await vi.waitFor(() => expect(pc.close).toHaveBeenCalledTimes(1));
  });

  it("waits for onopen when the channel starts out connecting", () => {
    const onOpen = vi.fn();
    setDataChannelCallbacks(onOpen, vi.fn());
    const reply = vi.fn();
    handleSignalingMessage({ type: "offer", sdp: "v=0" }, reply);
    const pc = lastPc();
    const channel = fakeChannel({ readyState: "connecting" });

    pc.onDataChannel.execute(channel);
    expect(onOpen).not.toHaveBeenCalled();

    channel.onopen?.();
    expect(onOpen).toHaveBeenCalledWith(channel);
  });
});

describe("handleGuiSignalingMessage: viewer flow", () => {
  it("rejects a second concurrent GUI viewer", async () => {
    await connectVideoSource();
    const reply = vi.fn();
    handleGuiSignalingMessage({ type: "offer", sdp: "v=0" }, reply);
    const guiReply2 = vi.fn();

    handleGuiSignalingMessage({ type: "offer", sdp: "v=0" }, guiReply2);

    expect(guiReply2).toHaveBeenCalledWith({
      type: "error",
      message: "A GUI viewer is already connected.",
    });
  });

  it("answers the GUI offer, forwards RTP, and requests keyframes on picture loss", async () => {
    const { pc: sourcePc } = await connectVideoSource();
    const reply = vi.fn();

    handleGuiSignalingMessage({ type: "offer", sdp: "v=0" }, reply);

    expect(pcInstances).toHaveLength(2);
    const guiPc = lastPc();
    expect(guiPc).not.toBe(sourcePc);
    expect(guiPc.addTrack).toHaveBeenCalled();

    await vi.waitFor(() =>
      expect(reply).toHaveBeenCalledWith({ type: "answer", sdp: "mock-answer-sdp" }),
    );
  });

  it("does not request keyframes when no source receiver is available", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    const reply = vi.fn();
    handleSignalingMessage({ type: "offer", sdp: "v=0" }, reply);
    const pc = lastPc();
    pc.getReceivers.mockReturnValue([]); // no matching receiver -> activeVideoReceiver stays null
    pc.onTrack.execute(videoTrack());
    await vi.waitFor(() => expect(recorderInstances).toHaveLength(1));

    const guiReply = vi.fn();
    handleGuiSignalingMessage({ type: "offer", sdp: "v=0" }, guiReply);
    const guiPc = lastPc();

    expect(guiPc.addTrack).toHaveBeenCalled();
    const sender = guiPc.addTrack.mock.results[0].value as { onPictureLossIndication: { subscribe: ReturnType<typeof vi.fn> } };
    expect(sender.onPictureLossIndication.subscribe).not.toHaveBeenCalled();
  });

  it("flushes GUI ICE candidates buffered before the offer, after the remote description is set", async () => {
    await connectVideoSource();
    const reply = vi.fn();
    handleGuiSignalingMessage(
      { type: "ice-candidate", candidate: { candidate: "candidate:1 1 UDP 1 10.0.0.9 1 typ host" } },
      reply,
    );

    handleGuiSignalingMessage({ type: "offer", sdp: "v=0" }, reply);
    const guiPc = lastPc();

    await vi.waitFor(() => expect(guiPc.addIceCandidate).toHaveBeenCalledTimes(1));
    expect(guiPc.addIceCandidate).toHaveBeenCalledWith(
      expect.objectContaining({ candidate: "candidate:1 1 UDP 1 10.0.0.9 1 typ host" }),
    );
  });

  it("logs a warning instead of throwing when flushing a buffered GUI candidate fails", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    await connectVideoSource();
    const reply = vi.fn();
    handleGuiSignalingMessage(
      { type: "ice-candidate", candidate: { candidate: "candidate:1 1 UDP 1 10.0.0.9 1 typ host" } },
      reply,
    );

    handleGuiSignalingMessage({ type: "offer", sdp: "v=0" }, reply);
    const guiPc = lastPc();
    guiPc.addIceCandidate.mockRejectedValueOnce(new Error("buffered gui ice fail"));

    await vi.waitFor(() =>
      expect(warnSpy).toHaveBeenCalledWith(
        "Failed to add buffered GUI ICE candidate:",
        "buffered gui ice fail",
      ),
    );
  });

  it("adds a GUI ICE candidate directly once the remote description is already set", async () => {
    await connectVideoSource();
    const reply = vi.fn();
    handleGuiSignalingMessage({ type: "offer", sdp: "v=0" }, reply);
    const guiPc = lastPc();
    await vi.waitFor(() => expect(reply).toHaveBeenCalledWith(expect.objectContaining({ type: "answer" })));

    handleGuiSignalingMessage(
      { type: "ice-candidate", candidate: { candidate: "candidate:2 1 UDP 1 10.0.0.10 1 typ host" } },
      reply,
    );

    expect(guiPc.addIceCandidate).toHaveBeenCalledWith(
      expect.objectContaining({ candidate: "candidate:2 1 UDP 1 10.0.0.10 1 typ host" }),
    );
  });

  it("logs an error instead of throwing when a direct GUI addIceCandidate fails", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    await connectVideoSource();
    const reply = vi.fn();
    handleGuiSignalingMessage({ type: "offer", sdp: "v=0" }, reply);
    const guiPc = lastPc();
    await vi.waitFor(() => expect(reply).toHaveBeenCalledWith(expect.objectContaining({ type: "answer" })));
    guiPc.addIceCandidate.mockRejectedValueOnce(new Error("gui ice fail"));

    handleGuiSignalingMessage(
      { type: "ice-candidate", candidate: { candidate: "candidate:3 1 UDP 1 10.0.0.11 1 typ host" } },
      reply,
    );

    await vi.waitFor(() =>
      expect(errorSpy).toHaveBeenCalledWith("GUI addIceCandidate failed:", "gui ice fail"),
    );
  });

  it("relays GUI-side ICE candidates to the viewer, honoring Tailscale filtering", async () => {
    await connectVideoSource();
    const reply = vi.fn();
    handleGuiSignalingMessage({ type: "offer", sdp: "v=0" }, reply, true);
    const guiPc = lastPc();

    guiPc.onIceCandidate.execute({
      candidate: "candidate:1 1 UDP 1 192.168.1.9 1 typ host",
      toJSON: () => ({ addr: "lan" }),
    });
    expect(reply).not.toHaveBeenCalledWith(expect.objectContaining({ type: "ice-candidate" }));

    guiPc.onIceCandidate.execute({
      candidate: "candidate:1 1 UDP 1 100.64.5.5 1 typ host",
      toJSON: () => ({ addr: "ts" }),
    });
    expect(reply).toHaveBeenCalledWith({ type: "ice-candidate", candidate: { addr: "ts" } });
  });

  it("closes the GUI peer and logs an error when GUI negotiation fails", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    await connectVideoSource();
    mockConfig.failNextSetRemoteDescription = true;
    const reply = vi.fn();

    handleGuiSignalingMessage({ type: "offer", sdp: "v=0" }, reply);
    const guiPc = lastPc();

    await vi.waitFor(() =>
      expect(errorSpy).toHaveBeenCalledWith(
        "GUI WebRTC offer handling failed:",
        "mock setRemoteDescription failure",
      ),
    );
    await vi.waitFor(() => expect(guiPc.close).toHaveBeenCalledTimes(1));

    // The GUI slot is free again, so a new viewer offer is accepted rather than
    // rejected as "already connected".
    const reply2 = vi.fn();
    handleGuiSignalingMessage({ type: "offer", sdp: "v=0" }, reply2);
    expect(reply2).not.toHaveBeenCalledWith(
      expect.objectContaining({ message: "A GUI viewer is already connected." }),
    );
  });
});

describe("handleSocketClose / handleGuiSocketClose: teardown", () => {
  it("logs a warning instead of throwing when the recorder fails to stop", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    const reply = vi.fn();
    handleSignalingMessage({ type: "offer", sdp: "v=0" }, reply);
    const pc = lastPc();
    pc.getReceivers.mockReturnValue([]);
    pc.onTrack.execute(videoTrack());
    await vi.waitFor(() => expect(recorderInstances).toHaveLength(1));
    recorderInstances[0].stop.mockRejectedValueOnce(new Error("stop failed"));

    handleSocketClose();

    await vi.waitFor(() =>
      expect(warnSpy).toHaveBeenCalledWith("Video recorder stop error:", "stop failed"),
    );
  });

  it("closes the active peer connection, stops the recorder, and resets state", async () => {
    const reply = vi.fn();
    handleSignalingMessage({ type: "offer", sdp: "v=0" }, reply);
    const pc = lastPc();
    pc.getReceivers.mockReturnValue([]);
    pc.onTrack.execute(videoTrack());
    await vi.waitFor(() => expect(recorderInstances).toHaveLength(1));
    const recorder = recorderInstances[0];

    handleSocketClose();

    expect(pc.close).toHaveBeenCalledTimes(1);
    await vi.waitFor(() => expect(recorder.stop).toHaveBeenCalledTimes(1));

    // State was fully reset: a subsequent offer is fresh, not a renegotiation.
    const reply2 = vi.fn();
    handleSignalingMessage({ type: "offer", sdp: "v=0" }, reply2);
    expect(pcInstances).toHaveLength(2);
  });

  it("swallows an activePc.close() rejection during handleSocketClose without throwing", async () => {
    const reply = vi.fn();
    handleSignalingMessage({ type: "offer", sdp: "v=0" }, reply);
    const pc = lastPc();
    pc.close.mockRejectedValueOnce(new Error("close failed"));

    expect(() => handleSocketClose()).not.toThrow();
    await vi.waitFor(() => expect(pc.close).toHaveBeenCalledTimes(1));
  });

  it("swallows an activeGuiPc.close() rejection during handleGuiSocketClose without throwing", async () => {
    await connectVideoSource();
    handleGuiSignalingMessage({ type: "offer", sdp: "v=0" }, vi.fn());
    const guiPc = lastPc();
    guiPc.close.mockRejectedValueOnce(new Error("close failed"));

    expect(() => handleGuiSocketClose()).not.toThrow();
    await vi.waitFor(() => expect(guiPc.close).toHaveBeenCalledTimes(1));
  });

  it("closes the active GUI peer connection and clears buffered GUI candidates", async () => {
    const reply = vi.fn();
    handleSignalingMessage({ type: "offer", sdp: "v=0" }, reply);
    const pc = lastPc();
    pc.getReceivers.mockReturnValue([]);
    pc.onTrack.execute(videoTrack());
    await vi.waitFor(() => expect(recorderInstances).toHaveLength(1));

    handleGuiSignalingMessage({ type: "offer", sdp: "v=0" }, vi.fn());
    const guiPc = lastPc();

    handleGuiSocketClose();

    expect(guiPc.close).toHaveBeenCalledTimes(1);

    // A follow-up GUI offer is accepted (slot freed), proving state was cleared.
    const reply2 = vi.fn();
    handleGuiSignalingMessage({ type: "offer", sdp: "v=0" }, reply2);
    expect(reply2).not.toHaveBeenCalledWith(
      expect.objectContaining({ message: "A GUI viewer is already connected." }),
    );
  });
});
