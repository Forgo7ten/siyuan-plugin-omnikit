import type { Side } from "../model/types.ts";

const DEFAULT_IME_STALE_MS = 10_000;

/**
 * Generation-guarded async diff scheduler with per-side IME composition suspension.
 * In-flight computations are aborted and superseded whenever new edits arrive.
 */
export class ComputeCoordinator<T> {
  private generation = 0;
  private timer?: ReturnType<typeof setTimeout>;
  private aborter?: AbortController;
  private disposed = false;
  private readonly composingSince = new Map<Side, number>();

  constructor(
    private readonly compute: (signal: AbortSignal) => Promise<T>,
    private readonly publish: (result: T) => void,
    private readonly onError: (reason: unknown) => void,
    private readonly debounceMs = 400,
    private readonly now: () => number = () => Date.now(),
    private readonly imeStaleMs = DEFAULT_IME_STALE_MS,
  ) {}

  compositionStart(side: Side): void {
    if (this.disposed) return;
    this.composingSince.set(side, this.now());
    this.invalidate();
  }

  compositionEnd(side: Side): void {
    if (this.disposed) return;
    this.composingSince.delete(side);
    this.request();
  }

  swapSides(): void {
    const left = this.composingSince.get("left");
    const right = this.composingSince.get("right");
    this.composingSince.clear();
    if (right !== undefined) this.composingSince.set("left", right);
    if (left !== undefined) this.composingSince.set("right", left);
  }

  private hasActiveComposition(): boolean {
    if (this.composingSince.size === 0) return false;
    const current = this.now();
    for (const [side, since] of [...this.composingSince.entries()]) {
      if (current - since > this.imeStaleMs) {
        this.composingSince.delete(side);
      }
    }
    return this.composingSince.size > 0;
  }

  get isScheduledOrRunning(): boolean {
    return !this.disposed && (this.timer !== undefined || this.aborter !== undefined || this.hasActiveComposition());
  }

  request(): void {
    this.invalidate();
    if (this.disposed || this.hasActiveComposition()) return;
    const ticket = this.generation;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      void this.runTicket(ticket);
    }, this.debounceMs);
  }

  immediate(): void {
    this.invalidate();
    if (this.disposed || this.hasActiveComposition()) return;
    void this.runTicket(this.generation);
  }

  private invalidate(): void {
    this.generation++;
    if (this.timer !== undefined) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
    this.aborter?.abort();
    this.aborter = undefined;
  }

  private async runTicket(ticket: number): Promise<void> {
    if (this.disposed || this.hasActiveComposition() || ticket !== this.generation) return;
    const aborter = new AbortController();
    this.aborter = aborter;
    try {
      const result = await this.compute(aborter.signal);
      if (!this.disposed && !aborter.signal.aborted && ticket === this.generation) {
        this.publish(result);
      }
    } catch (error) {
      if (!this.disposed && !aborter.signal.aborted && ticket === this.generation) {
        this.onError(error);
      }
    } finally {
      if (this.aborter === aborter) {
        this.aborter = undefined;
      }
    }
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.invalidate();
    this.composingSince.clear();
  }
}
