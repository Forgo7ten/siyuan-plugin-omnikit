import type { FeatureContext, FeatureMetadata } from "./FeatureContext.ts";
import { FeatureScope } from "./FeatureScope.ts";
import { isFrontendSupported } from "../host/Platform.ts";

export type FeaturePhase = "disabled" | "enabling" | "enabled" | "disabling" | "error" | "unsupported";

/**
 * @design A reusable lifecycle class. Runtime registrations live in FeatureScope.
 * @invariant Freeze invalidates scope synchronously but must not conceal pending
 * onDisable cleanup by changing phase to disabled before disposeAll runs.
 */
export abstract class BaseFeature {
  private phase: FeaturePhase = "disabled";
  private scope?: FeatureScope;
  private generation = 0;
  private failure?: unknown;
  private activation?: Promise<void>;
  private shutdown?: Promise<void>;

  protected constructor(readonly meta: FeatureMetadata) {}
  get status(): FeaturePhase {
    if (!isFrontendSupported(this.meta.frontends)) {
      return "unsupported";
    }
    return this.phase;
  }
  get enabled(): boolean { return this.status === "enabled" && this.scope?.active === true; }
  get error(): unknown { return this.failure; }

  protected abstract onEnable(context: FeatureContext, scope: FeatureScope): void | Promise<void>;
  protected onDisable(): void | Promise<void> {}
  protected onSettingsChanged(): void | Promise<void> {}

  async activate(context: FeatureContext): Promise<void> {
    if (!isFrontendSupported(this.meta.frontends)) {
      throw new Error(`Cannot activate feature ${this.meta.id}: unsupported frontend`);
    }
    if (this.enabled) return;
    if (this.phase !== "disabled" && this.phase !== "error") {
      throw new Error(`Invalid activate phase: ${this.phase}`);
    }
    this.phase = "enabling";
    const generation = ++this.generation;
    const scope = new FeatureScope();
    this.scope = scope;
    const scopedContext: FeatureContext = {
      ...context,
      scope,
      feedback: context.feedback?.forScope?.(scope) ?? context.feedback,
    };
    const promise = (async () => {
      try {
        await this.onEnable(scopedContext, scope);
        if (!scope.active || generation !== this.generation) {
          throw new Error(`Feature frozen during initialization: ${this.meta.id}`);
        }
        this.failure = undefined;
        this.phase = "enabled";
      } catch (error) {
        scope.dispose();
        if (this.scope === scope) this.scope = undefined;
        this.failure = error;
        this.phase = "error";
        throw error;
      }
    })();
    this.activation = promise;
    try { await promise; }
    finally { if (this.activation === promise) this.activation = undefined; }
  }

  /**
   * @safety Wait for pending onEnable to settle before running onDisable.
   * No old menu/task callback can operate because freeze disposed the scope first.
   */
  deactivate(): Promise<void> {
    if (this.phase === "disabled") return Promise.resolve();
    if (this.shutdown) return this.shutdown;
    let resolveShutdown!: () => void;
    let rejectShutdown!: (reason?: unknown) => void;
    const promise = new Promise<void>((resolve, reject) => {
      resolveShutdown = resolve;
      rejectShutdown = reject;
    });
    this.shutdown = promise;
    void this.performDeactivate(promise).then(resolveShutdown, rejectShutdown);
    return promise;
  }

  private async performDeactivate(promise: Promise<void>): Promise<void> {
    try {
      if (this.phase === "enabling") {
        // @safety Revoke the scope before waiting so an in-flight onEnable observes abort.
        this.generation++;
        this.scope?.dispose();
        this.scope = undefined;
        await this.activation?.catch(() => undefined);
      }
      if ((this.phase as FeaturePhase) === "disabled") return;
      this.phase = "disabling";
      this.generation++;
      this.failure = undefined;
      this.scope?.dispose();
      this.scope = undefined;
      try { await this.onDisable(); }
      finally { this.phase = "disabled"; }
    } finally {
      if (this.shutdown === promise) this.shutdown = undefined;
    }
  }

  /** Synchronous gate for unload; async cleanup remains the job of deactivate(). */
  freeze(): void {
    ++this.generation;
    this.scope?.dispose();
    // @invariant Do not set phase="disabled" here: onDisable may still be required.
  }

  async notifySettingsChanged(): Promise<void> {
    if (this.enabled) await this.onSettingsChanged();
  }
}
