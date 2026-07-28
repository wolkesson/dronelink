import { describe, expect, it, vi, afterEach } from "vitest";
import { LinkActivityTracker } from "./LinkActivityTracker.js";

describe("LinkActivityTracker", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("starts with zero counters and inactive LEDs", () => {
    const tracker = new LinkActivityTracker();
    const updates: string[] = [];

    tracker.onChange((snapshot) => {
      updates.push(`${snapshot.txBytes}/${snapshot.rxBytes}/${snapshot.txActive}/${snapshot.rxActive}`);
    });

    expect(updates).toEqual(["0/0/false/false"]);
  });

  it("pulses TX activity and accumulates TX bytes", () => {
    vi.useFakeTimers();
    const tracker = new LinkActivityTracker(100);
    const states: boolean[] = [];

    tracker.onChange((snapshot) => {
      states.push(snapshot.txActive);
    });

    tracker.recordTransmit(5);
    expect(states.at(-1)).toBe(true);

    vi.advanceTimersByTime(100);
    expect(states.at(-1)).toBe(false);
  });

  it("pulses RX activity and ignores zero-byte updates", () => {
    vi.useFakeTimers();
    const tracker = new LinkActivityTracker(100);
    const snapshots: Array<{ rxBytes: number; rxActive: boolean }> = [];

    tracker.onChange((snapshot) => {
      snapshots.push({ rxBytes: snapshot.rxBytes, rxActive: snapshot.rxActive });
    });

    tracker.recordReceive(0);
    tracker.recordReceive(3);
    expect(snapshots.at(-1)).toEqual({ rxBytes: 3, rxActive: true });

    vi.advanceTimersByTime(100);
    expect(snapshots.at(-1)).toEqual({ rxBytes: 3, rxActive: false });
  });
});
