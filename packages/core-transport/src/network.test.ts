import { describe, it, expect } from "vitest";
import { isTailscaleCandidate } from "./network.js";

function candidateWithIp(ip: string): string {
  return `candidate:1 1 UDP 2130706431 ${ip} 51820 typ host`;
}

describe("isTailscaleCandidate", () => {
  it("matches ICE candidates on the Tailscale CGNAT range (100.64.0.0/10)", () => {
    expect(isTailscaleCandidate(candidateWithIp("100.64.0.1"))).toBe(true);
    expect(isTailscaleCandidate(candidateWithIp("100.100.10.5"))).toBe(true);
    expect(isTailscaleCandidate(candidateWithIp("100.127.255.255"))).toBe(true);
  });

  it("rejects candidates just outside the range", () => {
    expect(isTailscaleCandidate(candidateWithIp("100.63.255.255"))).toBe(false);
    expect(isTailscaleCandidate(candidateWithIp("100.128.0.0"))).toBe(false);
  });

  it("rejects candidates on other private/non-Tailscale ranges", () => {
    expect(isTailscaleCandidate(candidateWithIp("192.168.1.1"))).toBe(false);
    expect(isTailscaleCandidate(candidateWithIp("10.0.0.1"))).toBe(false);
    expect(isTailscaleCandidate(candidateWithIp("172.16.0.1"))).toBe(false);
  });

  it("holds across the internal boundaries of the second-octet alternation", () => {
    // The regex splits 64-127 into 6[4-9] | [7-9]\d | 1[01]\d | 12[0-7].
    expect(isTailscaleCandidate("100.69.0.1")).toBe(true);
    expect(isTailscaleCandidate("100.70.0.1")).toBe(true);
    expect(isTailscaleCandidate("100.99.0.1")).toBe(true);
    expect(isTailscaleCandidate("100.100.0.1")).toBe(true);
    expect(isTailscaleCandidate("100.119.0.1")).toBe(true);
    expect(isTailscaleCandidate("100.120.0.1")).toBe(true);
  });

  it("is not fooled by a Tailscale-looking substring embedded in a larger number", () => {
    // "100" is not on a word boundary here, so this must not match.
    expect(isTailscaleCandidate("1100.64.0.1")).toBe(false);
    expect(isTailscaleCandidate("100.64.0.11 typ srflx")).toBe(true);
  });

  it("returns false for strings with no IPv4-shaped address at all", () => {
    expect(isTailscaleCandidate("")).toBe(false);
    expect(isTailscaleCandidate("candidate:1 1 UDP 2130706431 typ host")).toBe(false);
    expect(isTailscaleCandidate("not an ip address")).toBe(false);
  });
});
