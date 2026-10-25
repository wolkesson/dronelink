import { describe, expect, it, vi } from "vitest";
import { encodeMspV1 } from "@dronelink/fc-msp";
import { MspProbeBroker } from "./MspProbeBroker.js";

describe("MspProbeBroker", () => {
  it("consumes only the matching response, including fragmented frames", async () => {
    const write = vi.fn(async () => {});
    const forward = vi.fn();
    const broker = new MspProbeBroker(write);
    const pending = broker.request(1, forward);
    const response = encodeMspV1("response", 1, new Uint8Array([0, 1, 48]));
    const first = broker.receive(response.subarray(0, 3));
    expect(first).toEqual(new Uint8Array());
    const remaining = broker.receive(response.subarray(3));
    expect(remaining).toEqual(new Uint8Array());
    await expect(pending).resolves.toEqual(new Uint8Array([0, 1, 48]));
    expect(write).toHaveBeenCalledOnce();
    expect(forward).not.toHaveBeenCalled();
  });

  it("passes unrelated and invalid bytes unchanged and flushes incomplete bytes on timeout", async () => {
    const forward = vi.fn();
    const broker = new MspProbeBroker(async () => {}, 10);
    const pending = broker.request(1, forward);
    const unrelated = encodeMspV1("response", 2, new Uint8Array([9]));
    expect(broker.receive(unrelated)).toEqual(unrelated);
    const partial = new Uint8Array([0x24, 0x4d, 0x3e, 10]);
    expect(broker.receive(partial)).toEqual(new Uint8Array());
    await expect(pending).resolves.toBeNull();
    expect(forward).toHaveBeenCalledWith(partial);
  });

  it("flushes held bytes on cancellation and rejects overlapping queries", async () => {
    const forward = vi.fn();
    const broker = new MspProbeBroker(async () => {});
    const pending = broker.request(1, forward);
    expect(broker.receive(new Uint8Array([0x24, 0x4d, 0x3e, 1]))).toEqual(new Uint8Array());
    await expect(broker.request(2, forward)).rejects.toThrow("already pending");
    broker.cancel();
    await expect(pending).resolves.toBeNull();
    expect(forward).toHaveBeenCalledOnce();
  });
});
