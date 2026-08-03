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

export class QrPairingScanner {
  static isSupported(): boolean {
    return typeof window !== "undefined" && "BarcodeDetector" in window;
  }

  private readonly detectorFactory: () => BarcodeDetectorLike;
  private readonly mediaFactory: () => Promise<MediaStream>;
  private stream: MediaStream | null = null;
  private rafId: number | null = null;

  constructor(options: QrPairingScannerOptions = {}) {
    this.detectorFactory =
      options.detectorFactory ??
      (() =>
        new (window as unknown as { BarcodeDetector: new (init: { formats: string[] }) => BarcodeDetectorLike })[
          "BarcodeDetector"
        ]({ formats: ["qr_code"] }));
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
