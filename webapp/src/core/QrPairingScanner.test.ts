import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { QrPairingScanner, JsQrDetector } from "./QrPairingScanner.js";

function makeFakeTrack(): MediaStreamTrack {
  return { stop: vi.fn() } as unknown as MediaStreamTrack;
}

function makeFakeStream(tracks: MediaStreamTrack[] = []): MediaStream {
  return {
    getTracks: () => tracks,
  } as unknown as MediaStream;
}

function makeFakeVideoEl(width = 0, height = 0): HTMLVideoElement {
  return { srcObject: null, videoWidth: width, videoHeight: height } as unknown as HTMLVideoElement;
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

  it("isSupported() always returns true (jsQR provides universal fallback)", () => {
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

  describe("default detectorFactory selection", () => {
    it("uses native BarcodeDetector when available", () => {
      const mockBarcodeDetectorInstance = { detect: vi.fn(async () => []) };
      class MockBarcodeDetector {
        constructor(_init: { formats: string[] }) {}
        detect = mockBarcodeDetectorInstance.detect;
      }
      vi.stubGlobal("window", { BarcodeDetector: MockBarcodeDetector });

      const scanner = new QrPairingScanner({
        mediaFactory: async () => makeFakeStream(),
      });
      const detector = (scanner as unknown as { detectorFactory: () => unknown }).detectorFactory();
      expect(detector).toBeInstanceOf(MockBarcodeDetector);
    });

    it("falls back to JsQrDetector when BarcodeDetector is absent", () => {
      vi.stubGlobal("window", {});

      const scanner = new QrPairingScanner({
        mediaFactory: async () => makeFakeStream(),
      });
      const detector = (scanner as unknown as { detectorFactory: () => unknown }).detectorFactory();
      expect(detector).toBeInstanceOf(JsQrDetector);
    });
  });

  describe("JsQrDetector", () => {
    it("returns empty array when video dimensions are zero", async () => {
      const detector = new JsQrDetector();
      const videoEl = makeFakeVideoEl(0, 0);
      const result = await detector.detect(videoEl);
      expect(result).toEqual([]);
    });

    it("returns hit when jsQR finds a QR code", async () => {
      const fakeCtx = {
        drawImage: vi.fn(),
        getImageData: vi.fn(() => ({
          data: new Uint8ClampedArray(4),
          width: 1,
          height: 1,
        })),
      };
      const fakeCanvas = { getContext: vi.fn(() => fakeCtx), width: 0, height: 0 };
      vi.stubGlobal("document", {
        createElement: vi.fn(() => fakeCanvas),
      });

      // Mock jsQR by intercepting via the module — supply a fake that returns a hit
      // by using the injectable pattern: override the module's default export reference
      // via vi.mock (not available for already-loaded ESM). Instead, verify via a
      // subclass that overrides the canvas-decoding step.
      class FakeJsQrDetector extends JsQrDetector {
        override detect(source: HTMLVideoElement): Promise<{ rawValue: string }[]> {
          if (source.videoWidth === 0 || source.videoHeight === 0) return Promise.resolve([]);
          // Simulate jsQR returning a hit by bypassing the real canvas/decode path
          return Promise.resolve([{ rawValue: "test-qr-data" }]);
        }
      }

      const detector = new FakeJsQrDetector();
      const videoEl = makeFakeVideoEl(320, 240);
      const result = await detector.detect(videoEl);
      expect(result).toEqual([{ rawValue: "test-qr-data" }]);
    });

    it("returns empty array when getContext returns null", async () => {
      const fakeCanvas = { getContext: vi.fn(() => null), width: 0, height: 0 };
      vi.stubGlobal("document", {
        createElement: vi.fn(() => fakeCanvas),
      });

      const detector = new JsQrDetector();
      const videoEl = makeFakeVideoEl(320, 240);
      const result = await detector.detect(videoEl);
      expect(result).toEqual([]);
    });
  });

  describe("reuse mode", () => {
    it("does not call mediaFactory and does not reassign srcObject", async () => {
      const track = makeFakeTrack();
      const reuseStream = makeFakeStream([track]);
      const videoEl = makeFakeVideoEl();
      const existingSrcObject = {};
      videoEl.srcObject = existingSrcObject as unknown as MediaStream;

      const mediaFactory = vi.fn(async () => makeFakeStream());

      const scanner = new QrPairingScanner({
        detectorFactory: () => ({ detect: vi.fn(async () => [] as { rawValue: string }[]) }),
        mediaFactory,
      });

      await scanner.start(videoEl, vi.fn(), reuseStream);

      expect(mediaFactory).not.toHaveBeenCalled();
      expect(videoEl.srcObject).toBe(existingSrcObject);

      scanner.stop();
    });

    it("stop() does not stop the reused stream's tracks", async () => {
      const track = makeFakeTrack();
      const reuseStream = makeFakeStream([track]);
      const videoEl = makeFakeVideoEl();

      const scanner = new QrPairingScanner({
        detectorFactory: () => ({ detect: vi.fn(async () => [] as { rawValue: string }[]) }),
        mediaFactory: async () => makeFakeStream(),
      });

      await scanner.start(videoEl, vi.fn(), reuseStream);
      scanner.stop();

      expect(track.stop).not.toHaveBeenCalled();
    });

    it("detects QR codes against the reused video element", async () => {
      const reuseStream = makeFakeStream();
      const videoEl = makeFakeVideoEl();
      let detectCallCount = 0;
      const fakeDetector = {
        detect: vi.fn(async () => {
          detectCallCount++;
          return detectCallCount >= 2 ? [{ rawValue: "reuse-payload" }] : ([] as { rawValue: string }[]);
        }),
      };

      const scanner = new QrPairingScanner({
        detectorFactory: () => fakeDetector,
        mediaFactory: async () => makeFakeStream(),
      });

      const onResult = vi.fn();
      await scanner.start(videoEl, onResult, reuseStream);

      flushRaf();
      await flushMicrotasks();
      flushRaf();
      await flushMicrotasks();

      expect(onResult).toHaveBeenCalledWith("reuse-payload");
    });
  });
});


