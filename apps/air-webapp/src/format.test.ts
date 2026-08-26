import { describe, it, expect } from "vitest";
import { formatByteRate, formatMbps, formatDuration } from "./format.js";

describe("formatByteRate", () => {
  it("renders sub-1024 rates in whole bytes/sec", () => {
    expect(formatByteRate(0)).toBe("0 B/s");
    expect(formatByteRate(512)).toBe("512 B/s");
    expect(formatByteRate(1023)).toBe("1023 B/s");
  });

  it("rounds fractional byte rates to the nearest whole byte", () => {
    expect(formatByteRate(511.6)).toBe("512 B/s");
  });

  it("switches to KB/s at the 1024 boundary", () => {
    expect(formatByteRate(1024)).toBe("1.0 KB/s");
    expect(formatByteRate(1536)).toBe("1.5 KB/s");
    expect(formatByteRate(1024 * 100)).toBe("100.0 KB/s");
  });
});

describe("formatMbps", () => {
  it("converts bytes/sec to megabits/sec", () => {
    expect(formatMbps(0)).toBe("0.0 Mbps");
    expect(formatMbps(125_000)).toBe("1.0 Mbps");
    expect(formatMbps(1_000_000)).toBe("8.0 Mbps");
  });

  it("rounds to one decimal place", () => {
    expect(formatMbps(130_000)).toBe("1.0 Mbps");
    expect(formatMbps(137_500)).toBe("1.1 Mbps");
  });
});

describe("formatDuration", () => {
  it("formats sub-minute durations as 00:00:SS", () => {
    expect(formatDuration(0)).toBe("00:00:00");
    expect(formatDuration(45_000)).toBe("00:00:45");
  });

  it("formats minutes and hours with zero-padding", () => {
    expect(formatDuration(90_000)).toBe("00:01:30");
    expect(formatDuration(3_661_000)).toBe("01:01:01");
    expect(formatDuration(36_000_000)).toBe("10:00:00");
  });

  it("truncates (does not round) partial seconds", () => {
    expect(formatDuration(1_999)).toBe("00:00:01");
  });

  it("clamps negative durations to zero", () => {
    expect(formatDuration(-5000)).toBe("00:00:00");
  });
});
