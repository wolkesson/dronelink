import { describe, it, expect } from "vitest";
import { devSerialBridgeUrl } from "./platform.js";

describe("devSerialBridgeUrl", () => {
  it("returns null without the fc parameter", () => {
    expect(devSerialBridgeUrl("", true, false)).toBeNull();
    expect(devSerialBridgeUrl("?pair=1", true, false)).toBeNull();
  });

  it("returns the bridge URL for a loopback ws:// URL in a dev build", () => {
    expect(devSerialBridgeUrl("?fc=ws://localhost:5770", true, false)).toBe("ws://localhost:5770/");
    expect(devSerialBridgeUrl("?fc=ws://127.0.0.1:5770", true, false)).toBe("ws://127.0.0.1:5770/");
    expect(devSerialBridgeUrl("?fc=ws://[::1]:5770", true, false)).toBe("ws://[::1]:5770/");
  });

  it("ignores the parameter in a production build or inside android-shell", () => {
    expect(devSerialBridgeUrl("?fc=ws://localhost:5770", false, false)).toBeNull();
    expect(devSerialBridgeUrl("?fc=ws://localhost:5770", true, true)).toBeNull();
  });

  it("rejects non-loopback hosts, other schemes and malformed URLs", () => {
    expect(() => devSerialBridgeUrl("?fc=ws://192.168.1.10:5770", true, false)).toThrow("ws://localhost");
    expect(() => devSerialBridgeUrl("?fc=wss://localhost:5770", true, false)).toThrow("ws://localhost");
    expect(() => devSerialBridgeUrl("?fc=http://localhost:5770", true, false)).toThrow("ws://localhost");
    expect(() => devSerialBridgeUrl("?fc=not a url", true, false)).toThrow("Invalid ?fc=");
  });
});
