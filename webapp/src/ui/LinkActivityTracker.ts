export interface LinkActivitySnapshot {
  txBytes: number;
  rxBytes: number;
  txActive: boolean;
  rxActive: boolean;
}

type TimerHandle = ReturnType<typeof setTimeout>;
type ChangeHandler = (snapshot: LinkActivitySnapshot) => void;

export class LinkActivityTracker {
  private txBytes = 0;
  private rxBytes = 0;
  private txActive = false;
  private rxActive = false;
  private txTimer: TimerHandle | null = null;
  private rxTimer: TimerHandle | null = null;
  private onChangeHandler: ChangeHandler | null = null;

  constructor(private readonly holdMs = 180) {}

  onChange(handler: ChangeHandler): void {
    this.onChangeHandler = handler;
    this.emit();
  }

  recordTransmit(byteCount: number): void {
    if (byteCount <= 0) {
      return;
    }

    this.txBytes += byteCount;
    this.pulse("tx");
  }

  recordReceive(byteCount: number): void {
    if (byteCount <= 0) {
      return;
    }

    this.rxBytes += byteCount;
    this.pulse("rx");
  }

  private pulse(direction: "tx" | "rx"): void {
    if (direction === "tx") {
      this.txActive = true;
      if (this.txTimer) {
        clearTimeout(this.txTimer);
      }
      this.txTimer = setTimeout(() => {
        this.txActive = false;
        this.txTimer = null;
        this.emit();
      }, this.holdMs);
    } else {
      this.rxActive = true;
      if (this.rxTimer) {
        clearTimeout(this.rxTimer);
      }
      this.rxTimer = setTimeout(() => {
        this.rxActive = false;
        this.rxTimer = null;
        this.emit();
      }, this.holdMs);
    }

    this.emit();
  }

  private emit(): void {
    this.onChangeHandler?.({
      txBytes: this.txBytes,
      rxBytes: this.rxBytes,
      txActive: this.txActive,
      rxActive: this.rxActive,
    });
  }
}
