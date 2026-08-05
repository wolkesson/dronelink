import { describe, it, expect } from "vitest";
import { join } from "path";
import { isTailscaleCandidate, videoFilePath } from "./webrtc.js";

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
