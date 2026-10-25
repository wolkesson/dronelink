import { describe, expect, it } from "vitest";
import { HoldToConfirm } from "./hold-to-confirm.js";

describe("HoldToConfirm", () => {
  it("completes once, only after the full hold", () => {
    const hold = new HoldToConfirm(1_500);
    expect(hold.update(0)).toBe(false);
    hold.press(1_000);
    expect(hold.holding).toBe(true);
    expect(hold.progress(1_750)).toBe(0.5);
    expect(hold.update(2_499)).toBe(false);
    expect(hold.update(2_500)).toBe(true);
    expect(hold.update(2_600)).toBe(false);
    expect(hold.progress(9_000)).toBe(1);
  });

  it("never completes on a short press, and restarts the timer on every new press", () => {
    const hold = new HoldToConfirm(1_500);
    hold.press(0);
    hold.release();
    expect(hold.update(5_000)).toBe(false);
    expect(hold.progress(5_000)).toBe(0);
    hold.press(5_000);
    expect(hold.update(6_000)).toBe(false);
  });

  it("ignores repeated presses while held (OS key repeat)", () => {
    const hold = new HoldToConfirm(1_000);
    hold.press(0);
    hold.press(900);
    expect(hold.update(1_000)).toBe(true);
    expect(hold.progress(-10)).toBe(0);
  });

  it("defaults to the ADR's 1.5 s", () => {
    expect(new HoldToConfirm().holdMs).toBe(1_500);
  });
});
