import { describe, expect, it } from "vitest";
import { StickInput } from "./stick-input.js";

describe("StickInput", () => {
  it("maps the #88 keyboard layout at the default 50 % deflection", () => {
    const input = new StickInput();
    const cases: [string, Partial<Record<string, number>>][] = [
      ["KeyW", { pitch: 0.5 }], ["ArrowUp", { pitch: 0.5 }], ["KeyS", { pitch: -0.5 }], ["ArrowDown", { pitch: -0.5 }],
      ["KeyA", { roll: -0.5 }], ["ArrowLeft", { roll: -0.5 }], ["KeyD", { roll: 0.5 }], ["ArrowRight", { roll: 0.5 }],
      ["KeyQ", { yaw: -0.5 }], ["KeyE", { yaw: 0.5 }], ["KeyR", { throttle: 0.5 }], ["KeyF", { throttle: -0.5 }],
    ];
    for (const [code, expected] of cases) {
      expect(input.keyDown(code)).toBe(true);
      expect(input.values()).toEqual({ roll: 0, pitch: 0, yaw: 0, throttle: 0, ...expected });
      expect(input.keyUp(code)).toBe(true);
    }
    expect(input.keyDown("KeyZ")).toBe(false);
    expect(input.keyUp("KeyZ")).toBe(false);
  });

  it("combines axes, cancels opposite keys, clamps, and scales per axis", () => {
    const input = new StickInput();
    input.keyDown("KeyW");
    input.keyDown("KeyD");
    input.keyDown("KeyA");
    input.keyDown("ArrowRight");
    input.setDeflection("pitch", 1);
    input.setDeflection("roll", 0.2);
    expect(input.values()).toEqual({ roll: 0.2, pitch: 1, yaw: 0, throttle: 0 });
    input.setPad("right", { pitch: 1, roll: 1 });
    expect(input.values()).toMatchObject({ roll: 0.2, pitch: 1 });
    input.setPad("right", { pitch: -1 });
    expect(input.values().pitch).toBe(0);
    input.setPad("right", null);
    expect(input.active).toBe(true);
    input.clear();
    expect(input.active).toBe(false);
    expect(input.values()).toEqual({ roll: 0, pitch: 0, yaw: 0, throttle: 0 });
  });

  it("keeps the deflection within 0..1", () => {
    const input = new StickInput();
    input.setDeflection("yaw", 3);
    expect(input.getDeflection("yaw")).toBe(1);
    input.setDeflection("yaw", -1);
    expect(input.getDeflection("yaw")).toBe(0);
    input.setDeflection("yaw", Number.NaN);
    expect(input.getDeflection("yaw")).toBe(0);
    input.setPad("pad", { yaw: 1 });
    expect(input.values().yaw).toBe(0);
  });
});
