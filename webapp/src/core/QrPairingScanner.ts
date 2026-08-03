// jsQR is bundled as a fallback for browsers that lack the native BarcodeDetector API
// (e.g. Windows Chrome/Edge). It covers the same gap with no extra user setup required.
import jsQR from "jsqr";

interface BarcodeDetectorResult {
  rawValue: string;
}

interface BarcodeDetectorLike {
  detect(source: HTMLVideoElement): Promise<BarcodeDetectorResult[]>;
}

export interface QrPairingScannerOptions {
  detectorFactory?: () => BarcodeDetectorLike;
  mediaFactory?: () => Promise<MediaStream>;
}

export class JsQrDetector implements BarcodeDetectorLike {
  detect(source: HTMLVideoElement): Promise<BarcodeDetectorResult[]> {
    const width = source.videoWidth;
    const height = source.videoHeight;
    if (width === 0 || height === 0) return Promise.resolve([]);

    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext("2d");
    if (!ctx) return Promise.resolve([]);

    ctx.drawImage(source, 0, 0, width, height);
    const imageData = ctx.getImageData(0, 0, width, height);
    const result = jsQR(imageData.data, imageData.width, imageData.height);
    return Promise.resolve(result ? [{ rawValue: result.data }] : []);
  }
}

export class QrPairingScanner {
  // jsQR provides a pure-JS fallback so scanning is always available.
  static isSupported(): boolean {
    return true;
  }

  private readonly detectorFactory: () => BarcodeDetectorLike;
  private readonly mediaFactory: () => Promise<MediaStream>;
  private stream: MediaStream | null = null;
  private rafId: number | null = null;

  constructor(options: QrPairingScannerOptions = {}) {
    this.detectorFactory =
      options.detectorFactory ??
      (() => {
        if (typeof window !== "undefined" && "BarcodeDetector" in window) {
          return new (
            window as unknown as {
              BarcodeDetector: new (init: { formats: string[] }) => BarcodeDetectorLike;
            }
          ).BarcodeDetector({ formats: ["qr_code"] });
        }
        return new JsQrDetector();
      });
    this.mediaFactory =
      options.mediaFactory ??
      (() =>
        navigator.mediaDevices.getUserMedia({
          video: { facingMode: { ideal: "environment" } },
        }));
  }

  async start(videoEl: HTMLVideoElement, onResult: (text: string) => void): Promise<void> {
    const stream = await this.mediaFactory();
    this.stream = stream;
    videoEl.srcObject = stream;

    const detector = this.detectorFactory();

    const tick = async () => {
      if (this.rafId === null) return;
      try {
        const results = await detector.detect(videoEl);
        if (this.rafId !== null && results.length > 0 && results[0].rawValue) {
          this.stop();
          onResult(results[0].rawValue);
          return;
        }
      } catch {
        // ignore detection errors and keep polling
      }
      if (this.rafId !== null) {
        this.rafId = requestAnimationFrame(() => {
          void tick();
        });
      }
    };

    this.rafId = requestAnimationFrame(() => {
      void tick();
    });
  }

  stop(): void {
    if (this.rafId !== null) {
      cancelAnimationFrame(this.rafId);
      this.rafId = null;
    }
    if (this.stream) {
      this.stream.getTracks().forEach((t) => t.stop());
      this.stream = null;
    }
  }
}
