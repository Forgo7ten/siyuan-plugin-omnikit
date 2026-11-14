/** @invariant Feature disable/unload aborts every registered task and prevents stale tasks surviving it. */
export class TaskRegistry {
  private readonly controllers = new Map<AbortController, () => void>();
  private disposed = false;

  get activeCount(): number { return this.controllers.size; }

  create(parent?: AbortSignal): AbortController {
    const controller = new AbortController();
    if (this.disposed) {
      controller.abort("Task registry is disposed");
      return controller;
    }
    const onParentAbort = () => controller.abort(parent?.reason ?? "Parent task cancelled");
    if (parent?.aborted) onParentAbort();
    else parent?.addEventListener("abort", onParentAbort, { once: true });
    const cleanup = () => {
      parent?.removeEventListener("abort", onParentAbort);
      this.controllers.delete(controller);
    };
    this.controllers.set(controller, cleanup);
    controller.signal.addEventListener("abort", cleanup, { once: true });
    if (controller.signal.aborted) cleanup();
    return controller;
  }

  /** Release a completed task without cancelling it. */
  release(controller: AbortController): void {
    this.controllers.get(controller)?.();
  }

  cancelAll(reason: unknown = "Feature disabled"): void {
    for (const controller of [...this.controllers.keys()]) controller.abort(reason);
    this.controllers.clear();
  }

  /** Permanently close the registry; subsequent create() returns an aborted controller. */
  dispose(reason: unknown = "Feature disposed"): void {
    if (this.disposed) return;
    this.disposed = true;
    this.cancelAll(reason);
  }
}
