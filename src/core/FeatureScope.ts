export type Disposer = () => void;

/** Centralized ownership of every runtime resource in one feature activation. */
export class FeatureScope {
  private readonly disposers: Disposer[] = [];
  private alive = true;
  private readonly controller = new AbortController();
  get active(): boolean { return this.alive; }
  get signal(): AbortSignal { return this.controller.signal; }

  /** @invariant A late asynchronous registration cannot resurrect a frozen feature. */
  own(disposer: Disposer): void {
    if (!this.alive) { disposer(); return; }
    this.disposers.push(disposer);
  }

  guard<T extends (...args: any[]) => unknown>(handler: T): T {
    return ((...args: Parameters<T>) => {
      if (!this.alive) return undefined;
      return handler(...args);
    }) as T;
  }

  dispose(): void {
    if (!this.alive) return;
    this.alive = false;
    this.controller.abort("Feature disabled");
    for (const cleanup of this.disposers.splice(0).reverse()) {
      try { cleanup(); }
      catch (error) { console.error("[OmniKit][error] 清理功能作用域失败", error); }
    }
  }
}
