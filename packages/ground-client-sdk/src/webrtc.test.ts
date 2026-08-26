import { describe, it, expect, vi, afterEach } from "vitest";
import { join } from "path";
import { isTailscaleCandidate } from "@dronelink/core-transport";
import { MediaStreamTrack } from "werift";
import {
  forwardRtpTrack,
  videoFilePath,
  handleSignalingMessage,
  handleGuiSignalingMessage,
  handleSocketClose,
  handleGuiSocketClose,
  requestKeyFrameOnPictureLoss,
} from "./webrtc.js";

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
    expect(isTailscaleCandidate("candidate:1 1 UDP 2130706431 172.16.0.1 51820 typ host")).toBe(false);
  });
});

describe("videoFilePath", () => {
  it("returns a .webm path under the given directory with the session ID", () => {
    const result = videoFilePath("/var/dronelink", "abc123");
    expect(result).toBe(join("/var/dronelink", "video-abc123.webm"));
  });

  it("uses the provided directory and session ID verbatim", () => {
    expect(videoFilePath("/tmp/state", "sess-42")).toBe(join("/tmp/state", "video-sess-42.webm"));
    expect(videoFilePath(".", "x")).toBe(join(".", "video-x.webm"));
  });
});

describe("forwardRtpTrack", () => {
  it("copies RTP packets to a fresh local track and detaches when stopped", () => {
    const source = new MediaStreamTrack({ kind: "video" });
    const forwarder = forwardRtpTrack(source);
    const received: unknown[] = [];
    forwarder.track.onReceiveRtp.subscribe((packet) => received.push(packet));
    const packet = {
      clone: () => ({ header: { payloadType: 96 } }),
    };

    source.onReceiveRtp.execute(packet as never);
    expect(received).toHaveLength(1);
    expect(received[0]).not.toBe(packet);

    forwarder.stop();
    source.onReceiveRtp.execute(packet as never);
    expect(received).toHaveLength(1);
  });
});

describe("requestKeyFrameOnPictureLoss", () => {
  it("requests a keyframe from the source receiver when the GUI sender reports picture loss", () => {
    const listeners: Array<() => void> = [];
    const sender = { onPictureLossIndication: { subscribe: (cb: () => void) => listeners.push(cb) } };
    const sendRtcpPLI = vi.fn(async () => {});
    const receiver = { sendRtcpPLI };

    requestKeyFrameOnPictureLoss(sender as never, receiver as never, 12345);
    expect(listeners).toHaveLength(1);

    listeners[0]();
    expect(sendRtcpPLI).toHaveBeenCalledWith(12345);
  });

  it("logs a warning instead of throwing when sendRtcpPLI rejects", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const listeners: Array<() => void> = [];
    const sender = { onPictureLossIndication: { subscribe: (cb: () => void) => listeners.push(cb) } };
    const receiver = {
      sendRtcpPLI: vi.fn(async () => {
        throw new Error("boom");
      }),
    };

    requestKeyFrameOnPictureLoss(sender as never, receiver as never, 1);
    listeners[0]();
    await Promise.resolve();
    await Promise.resolve();

    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("Failed to request keyframe"), "boom");
    warnSpy.mockRestore();
  });
});

describe("handleSignalingMessage", () => {
  afterEach(() => {
    handleSocketClose();
    handleGuiSocketClose();
    vi.restoreAllMocks();
  });

  it("ignores non-object messages", () => {
    const reply = vi.fn();
    handleSignalingMessage(null as never, reply);
    handleSignalingMessage(undefined as never, reply);
    handleSignalingMessage("offer" as never, reply);
    expect(reply).not.toHaveBeenCalled();
  });

  it("ignores messages with an unrecognized type", () => {
    const reply = vi.fn();
    handleSignalingMessage({ type: "unknown" }, reply);
    expect(reply).not.toHaveBeenCalled();
  });

  it("ignores a second offer while a connection is already active", () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const reply1 = vi.fn();
    const reply2 = vi.fn();

    handleSignalingMessage({ type: "offer", sdp: "" }, reply1);
    handleSignalingMessage({ type: "offer", sdp: "" }, reply2);

    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("ignoring offer — connection already active"),
    );
    expect(reply2).not.toHaveBeenCalled();
  });

  it("buffers an ice-candidate received before any offer, without replying or throwing", () => {
    const reply = vi.fn();
    expect(() =>
      handleSignalingMessage(
        { type: "ice-candidate", candidate: { candidate: "candidate:1 1 UDP 1 10.0.0.1 5000 typ host" } },
        reply,
      ),
    ).not.toThrow();
    expect(reply).not.toHaveBeenCalled();
  });

  it("ignores an ice-candidate with a malformed candidate payload", () => {
    const reply = vi.fn();
    handleSignalingMessage({ type: "ice-candidate", candidate: "not-an-object" }, reply);
    handleSignalingMessage({ type: "ice-candidate", candidate: { candidate: 123 } }, reply);
    handleSignalingMessage({ type: "ice-candidate" }, reply);
    expect(reply).not.toHaveBeenCalled();
  });
});

describe("handleGuiSignalingMessage", () => {
  afterEach(() => {
    handleSocketClose();
    handleGuiSocketClose();
    vi.restoreAllMocks();
  });

  it("ignores non-object messages", () => {
    const reply = vi.fn();
    handleGuiSignalingMessage(null, reply);
    handleGuiSignalingMessage("offer", reply);
    expect(reply).not.toHaveBeenCalled();
  });

  it("ignores messages with an unrecognized type", () => {
    const reply = vi.fn();
    handleGuiSignalingMessage({ type: "unknown" }, reply);
    expect(reply).not.toHaveBeenCalled();
  });

  it("replies with an error when no incoming video is available yet", () => {
    const reply = vi.fn();
    handleGuiSignalingMessage({ type: "offer", sdp: "" }, reply);
    expect(reply).toHaveBeenCalledWith({
      type: "error",
      message: "No incoming video is available yet.",
    });
  });

  it("buffers an ice-candidate received before any GUI offer, without replying or throwing", () => {
    const reply = vi.fn();
    expect(() =>
      handleGuiSignalingMessage(
        { type: "ice-candidate", candidate: { candidate: "candidate:1 1 UDP 1 10.0.0.1 5000 typ host" } },
        reply,
      ),
    ).not.toThrow();
    expect(reply).not.toHaveBeenCalled();
  });

  it("ignores an ice-candidate with a malformed candidate payload", () => {
    const reply = vi.fn();
    handleGuiSignalingMessage({ type: "ice-candidate", candidate: "not-an-object" }, reply);
    handleGuiSignalingMessage({ type: "ice-candidate", candidate: { candidate: 123 } }, reply);
    handleGuiSignalingMessage({ type: "ice-candidate" }, reply);
    expect(reply).not.toHaveBeenCalled();
  });
});

describe("handleSocketClose / handleGuiSocketClose", () => {
  it("are safe to call when no connection is active", () => {
    expect(() => handleSocketClose()).not.toThrow();
    expect(() => handleGuiSocketClose()).not.toThrow();
  });

  it("are idempotent when called repeatedly", () => {
    handleSocketClose();
    expect(() => handleSocketClose()).not.toThrow();
    handleGuiSocketClose();
    expect(() => handleGuiSocketClose()).not.toThrow();
  });
});
