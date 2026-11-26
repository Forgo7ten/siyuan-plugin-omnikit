import type { Side } from "../model/types.ts";

/**
 * Tracks monotonic edit revisions per side and only certifies parity once a kernel snapshot
 * read after that revision matches the live editor state.
 */
export class DirtyGate {
  private revision: Record<Side, number> = { left: 0, right: 0 };
  private proven: Record<Side, number> = { left: 0, right: 0 };

  edit(side: Side): number {
    return ++this.revision[side];
  }

  swapSides(): void {
    this.revision = { left: this.revision.right, right: this.revision.left };
    this.proven = { left: this.proven.right, right: this.proven.left };
  }

  capture(): Readonly<Record<Side, number>> {
    return { left: this.revision.left, right: this.revision.right };
  }

  acknowledge(side: Side, capturedRevision: number, verified: boolean): void {
    if (!verified || capturedRevision > this.revision[side]) return;
    this.proven[side] = Math.max(this.proven[side], capturedRevision);
  }

  isSidePending(side: Side): boolean {
    return this.revision[side] > this.proven[side];
  }

  get pending(): boolean {
    return this.isSidePending("left") || this.isSidePending("right");
  }

  get status(): "verified" | "unconfirmed" {
    return this.pending ? "unconfirmed" : "verified";
  }
}
