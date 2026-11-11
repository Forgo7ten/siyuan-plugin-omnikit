import type { BaseFeature } from "./BaseFeature.ts";
import type { FeatureContext } from "./FeatureContext.ts";
import { FeatureCatalog } from "./FeatureCatalog.ts";

export interface FeatureStatus {
  id: string;
  title: string;
  description: string;
  status: string;
  error?: string;
}

/**
 * @invariant Per-feature operations are serialized. Runtime state is changed before the
 * desired preference is persisted, and a failed save is compensated.
 */
export class FeatureManager {
  private frozen = false;
  private readonly queues = new Map<string, Promise<boolean>>();
  private readonly startupErrors = new Map<string, unknown>();

  constructor(private readonly catalog: FeatureCatalog, private readonly context: FeatureContext) {}

  /** Startup reads the desired state only; it never writes settings. */
  async initialize(): Promise<void> {
    for (const feature of this.catalog.all()) {
      if (this.frozen) return;
      const shouldEnable = this.context.settings.getFeatureEnabled(feature.meta.id, feature.meta.defaultEnabled);
      this.context.logger.debug(`启动功能：${feature.meta.id}`, { 期望启用: shouldEnable });
      if (!shouldEnable) continue;
      await this.enqueue(feature.meta.id, async current => {
        if (this.frozen) return false;
        try {
          await current.activate(this.context);
          this.startupErrors.delete(current.meta.id);
          return true;
        } catch (error) {
          // @invariant A failed startup keeps the preference true and exposes an error state.
          this.startupErrors.set(current.meta.id, error);
          this.context.logger.error(`启用功能失败：${current.meta.id}`, error);
          return false;
        }
      });
    }
  }

  enable(id: string, persist = true): Promise<boolean> {
    return this.setEnabled(id, true, persist);
  }

  disable(id: string, persist = true): Promise<boolean> {
    return this.setEnabled(id, false, persist);
  }

  /**
   * @safety Runtime is revoked before persistence. When a save fails, the previous runtime
   * state is restored; a failed activation never rewrites the user's preference.
   */
  setEnabled(id: string, desired: boolean, persist = true): Promise<boolean> {
    const feature = this.catalog.get(id);
    if (!feature) return Promise.resolve(false);

    return this.enqueue(id, async current => {
      if (this.frozen) return false;
      const wasRunning = current.enabled;
      const savedDesired = this.context.settings.getFeatureEnabled(id, current.meta.defaultEnabled);
      this.context.logger.debug(`切换功能状态：${id}`, { 期望启用: desired, 当前运行: wasRunning, 已保存状态: savedDesired, 保存设置: persist });
      if (wasRunning === desired && savedDesired === desired) return true;

      if (desired) {
        if (!wasRunning) {
          try { await current.activate(this.context); }
          catch (error) {
            this.startupErrors.set(id, error);
            this.context.logger.error(`启用功能失败：${id}`, error);
            return false;
          }
          this.startupErrors.delete(id);
        }
        if (persist && !savedDesired) {
          try { await this.context.settings.setFeatureEnabled(id, true); }
          catch (error) {
            if (!wasRunning) await current.deactivate().catch(() => undefined);
            this.context.logger.error(`保存功能设置失败，已回滚启用状态：${id}`, error);
            return false;
          }
        }
        return true;
      }

      if (wasRunning) {
        try { await current.deactivate(); }
        catch (error) {
          // @invariant The scope is already revoked even when onDisable failed.
          this.context.logger.error(`停用功能失败：${id}`, error);
          return false;
        }
      }
      if (persist && savedDesired) {
        try { await this.context.settings.setFeatureEnabled(id, false); }
        catch (error) {
          this.context.logger.error(`保存功能设置失败，正在恢复原状态：${id}`, error);
          if (wasRunning && !this.frozen) {
            try { await current.activate(this.context); } catch { /* runtime stays disabled */ }
          }
          return false;
        }
      }
      return true;
    });
  }

  isRunning(id: string): boolean { return this.catalog.get(id)?.enabled === true; }

  getStartupError(id: string): unknown { return this.startupErrors.get(id) ?? this.catalog.get(id)?.error; }

  /** @invariant External configuration changes never write settings back. */
  async reconcileFromLoadedSettings(): Promise<void> {
    for (const feature of this.catalog.all()) {
      if (this.frozen) return;
      const desired = this.context.settings.getFeatureEnabled(feature.meta.id, feature.meta.defaultEnabled);
      await this.enqueue(feature.meta.id, async current => {
        if (this.frozen) return false;
        if (desired && !current.enabled) {
          try { await current.activate(this.context); this.startupErrors.delete(current.meta.id); }
          catch (error) { this.startupErrors.set(current.meta.id, error); this.context.logger.error(`启用功能失败：${current.meta.id}`, error); }
        } else if (!desired && current.enabled) {
          await current.deactivate().catch(error => this.context.logger.error(`停用功能失败：${current.meta.id}`, error));
        } else if (current.enabled) {
          await current.notifySettingsChanged().catch(error => this.context.logger.error(`更新功能设置失败：${current.meta.id}`, error));
        }
        return true;
      });
    }
  }

  async notifySettingsChanged(id?: string): Promise<void> {
    const features = id ? [this.catalog.get(id)] : this.catalog.all();
    for (const feature of features) {
      if (!feature) continue;
      try { await feature.notifySettingsChanged(); }
      catch (error) { this.context.logger.error(`更新功能设置失败：${feature.meta.id}`, error); }
    }
  }

  /** @safety Synchronous freeze is safe from Plugin.onunload. */
  freezeAll(): void {
    this.frozen = true;
    for (const feature of this.catalog.all()) feature.freeze();
  }

  /** @safety Waits for every feature shutdown and continues after individual failures. */
  async disposeAll(): Promise<void> {
    this.freezeAll();
    const errors: unknown[] = [];
    for (const feature of [...this.catalog.all()].reverse()) {
      if (feature.status === "disabled") continue;
      try { await feature.deactivate(); }
      catch (error) { errors.push(error); this.context.logger.error(`清理功能失败：${feature.meta.id}`, error); }
    }
    if (errors.length) throw new AggregateError(errors, "清理功能失败");
  }

  statuses(): FeatureStatus[] {
    return this.catalog.all().map(feature => ({
      id: feature.meta.id,
      title: feature.meta.title,
      description: feature.meta.description,
      status: feature.status,
      error: describeError(this.getStartupError(feature.meta.id)),
    }));
  }

  private enqueue(id: string, operation: (feature: BaseFeature) => Promise<boolean>): Promise<boolean> {
    const feature = this.catalog.get(id);
    if (!feature) return Promise.resolve(false);
    const prior = this.queues.get(id) ?? Promise.resolve(true);
    const current = prior.catch(() => false).then(() => operation(feature));
    this.queues.set(id, current);
    void current.finally(() => { if (this.queues.get(id) === current) this.queues.delete(id); }).catch(() => undefined);
    return current;
  }
}

function describeError(error: unknown): string | undefined {
  if (error === undefined) return undefined;
  if (error instanceof Error) return error.message;
  return String(error);
}
