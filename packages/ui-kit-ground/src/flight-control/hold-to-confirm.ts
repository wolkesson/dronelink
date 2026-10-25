/**
 * Press-and-hold confirmation (ARCHITECTURE.md 7.2: the unlock manoeuvre). Completes only after
 * the input has been held continuously for `holdMs`; a click, tap or key press shorter than that
 * never completes, and each press completes at most once.
 */
export class HoldToConfirm {
  private pressedAt: number | null = null;
  private completed = false;

  constructor(readonly holdMs = 1_500) {}

  get holding(): boolean {
    return this.pressedAt !== null;
  }

  /** Starts a hold. Pressing again while already held (e.g. OS key repeat) keeps the original start. */
  press(now: number): void {
    if (this.pressedAt !== null) return;
    this.pressedAt = now;
    this.completed = false;
  }

  /** Ends the hold, completed or not. */
  release(): void {
    this.pressedAt = null;
    this.completed = false;
  }

  /** 0..1 while held, 0 otherwise. */
  progress(now: number): number {
    if (this.pressedAt === null) return 0;
    return Math.min(1, Math.max(0, (now - this.pressedAt) / this.holdMs));
  }

  /** True exactly once per press, on the first update at or after the hold time. */
  update(now: number): boolean {
    if (this.pressedAt === null || this.completed || this.progress(now) < 1) return false;
    this.completed = true;
    return true;
  }
}
