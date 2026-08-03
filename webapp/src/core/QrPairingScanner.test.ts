import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { QrPairingScanner } from "./QrPairingScanner.js";

function makeFakeTrack(): MediaStreamTrack {
  return { stop: vi.fn() } as unknown as MediaStreamTrack;
}

function makeFakeStream(tracks: MediaStreamTrack[] = []): MediaStream {
  return {
    getTracks: () => tracks,
  } as unknown as MediaStream;
}

function makeFakeVideoEl(): HTMLVideoElement {
  return { srcObject: null } as unknown as HTMLVideoElement;
}

async function flushMicrotasks(n = 5): Promise<void> {
  for (let i = 0; i < n; i++) await Promise.resolve();
}

describe("QrPairingScanner", () => {
  let rafCallbacks: Array<() => void>;
  let rafIdCounter: number;

  beforeEach(() => {
    rafCallbacks = [];
    rafIdCounter = 1;
    vi.stubGlobal("requestAnimationFrame", (cb: () => void) => {
      rafCallbacks.push(cb);
      return rafIdCounter++;
    });
    vi.stubGlobal("cancelAnimationFrame", vi.fn());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function flushRaf(): void {
    const pending = rafCallbacks.splice(0);
    for (const cb of pending) cb();
  }

  it("isSupported() returns false when BarcodeDetector is absent", () => {
    vi.stubGlobal("window", {});
    expect(QrPairingScanner.isSupported()).toBe(false);
  });

  it("isSupported() returns true when BarcodeDetector is present", () => {
    vi.stubGlobal("window", { BarcodeDetector: class {} });
    expect(QrPairingScanner.isSupported()).toBe(true);
  });

  it("calls onResult with the rawValue from the first QR detection", async () => {
    const track = makeFakeTrack();
    const stream = makeFakeStream([track]);
    const videoEl = makeFakeVideoEl();

    let detectCallCount = 0;
    const fakeDetector = {
      detect: vi.fn(async () => {
        detectCallCount++;
        // Return a hit on the 3rd call
        if (detectCallCount >= 3) {
          return [{ rawValue: "qr-payload" }];
        }
        return [] as { rawValue: string }[];
      }),
    };

    const scanner = new QrPairingScanner({
      detectorFactory: () => fakeDetector,
      mediaFactory: async () => stream,
    });

    const onResult = vi.fn();
    // start() resolves after mediaFactory() completes and the first RAF is scheduled
    await scanner.start(videoEl, onResult);

    // Tick 1: detect returns [] (call 1)
    flushRaf();
    await flushMicrotasks();

    // Tick 2: detect returns [] (call 2)
    flushRaf();
    await flushMicrotasks();

    // Tick 3: detect returns hit (call 3)
    flushRaf();
    await flushMicrotasks();

    expect(onResult).toHaveBeenCalledOnce();
    expect(onResult).toHaveBeenCalledWith("qr-payload");
  });

  it("stop() halts scanning and stops all media tracks", async () => {
    const track = makeFakeTrack();
    const stream = makeFakeStream([track]);
    const videoEl = makeFakeVideoEl();

    const fakeDetector = {
      detect: vi.fn(async () => [] as { rawValue: string }[]),
    };

    const scanner = new QrPairingScanner({
      detectorFactory: () => fakeDetector,
      mediaFactory: async () => stream,
    });

    const onResult = vi.fn();
    await scanner.start(videoEl, onResult);

    // Let one tick fire
    flushRaf();
    await flushMicrotasks();

    scanner.stop();

    expect(onResult).not.toHaveBeenCalled();
    expect(track.stop).toHaveBeenCalled();
  });

  it("stop() is safe to call multiple times", async () => {
    const stream = makeFakeStream();
    const videoEl = makeFakeVideoEl();

    const scanner = new QrPairingScanner({
      detectorFactory: () => ({ detect: vi.fn(async () => [] as { rawValue: string }[]) }),
      mediaFactory: async () => stream,
    });

    await scanner.start(videoEl, vi.fn());

    expect(() => {
      scanner.stop();
      scanner.stop();
      scanner.stop();
    }).not.toThrow();
  });

  it("stop() is safe to call before start()", () => {
    const scanner = new QrPairingScanner({
      detectorFactory: () => ({ detect: vi.fn(async () => [] as { rawValue: string }[]) }),
      mediaFactory: async () => makeFakeStream(),
    });

    expect(() => scanner.stop()).not.toThrow();
  });

  it("sets videoEl.srcObject to the media stream", async () => {
    const stream = makeFakeStream();
    const videoEl = makeFakeVideoEl();

    const scanner = new QrPairingScanner({
      detectorFactory: () => ({ detect: vi.fn(async () => [] as { rawValue: string }[]) }),
      mediaFactory: async () => stream,
    });

    await scanner.start(videoEl, vi.fn());

    expect(videoEl.srcObject).toBe(stream);
    scanner.stop();
  });
});

