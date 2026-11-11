import { showMessage } from "siyuan";
import { BaseFeature } from "../../core/BaseFeature.ts";
import type { FeatureContext } from "../../core/FeatureContext.ts";
import type { FeatureScope } from "../../core/FeatureScope.ts";
import type { MenuContext } from "../../core/MenuRegistry.ts";
import type { SettingsManager } from "../../core/SettingsManager.ts";
import type { Logger } from "../../core/Logger.ts";
import { PageAllowlist } from "./PageAllowlist.ts";
import { AssetRepository } from "./AssetRepository.ts";
import { isDocumentRootIdentity, type BlockIdentity } from "./DocumentIdentity.ts";
import { ImageCompressorService } from "./ImageCompressorService.ts";
import { TaskRegistry } from "./TaskRegistry.ts";
import { IMAGE_FEATURE_ID, type ImageSettings } from "./settings.ts";
import type { ImageFeatureConfig } from "./registration.ts";
import { registerAutoUpload } from "./AutoUploadHandler.ts";
import { shouldAutoCompress } from "./AutoPolicy.ts";
import { imageMenuContributions } from "./menuContributions.ts";
import { compressSelectedImage } from "./SingleImageAction.ts";
import { compressDocumentImages } from "./DocumentBatchAction.ts";
import { translate } from "../../i18n/translate.ts";

/**
 * @invariant The feature owns all business registrations through FeatureScope.
 * @safety Disabling the feature immediately removes menus/auto upload and cancels
 * remaining compressions; the original asset is never deleted.
 */
export class ImageCompressorFeature extends BaseFeature {
  static readonly ID = IMAGE_FEATURE_ID;
  readonly pages: PageAllowlist;
  private readonly service = new ImageCompressorService();
  private readonly tasks = new TaskRegistry();
  private readonly assets = new AssetRepository();

  constructor(plugin: FeatureContext["plugin"], settings: SettingsManager) {
    super({
      id: IMAGE_FEATURE_ID,
      title: translate(plugin.i18n as Record<string, unknown>, `feature.${IMAGE_FEATURE_ID}.title`),
      description: translate(plugin.i18n as Record<string, unknown>, `feature.${IMAGE_FEATURE_ID}.description`),
      category: "media",
      icon: "iconOmnikitMenu",
      defaultEnabled: true,
      minimumAppVersion: "3.8.0",
    });
    this.pages = new PageAllowlist(settings);
  }

  private t(ctx: FeatureContext, key: string, values: Record<string, string | number> = {}): string {
    return translate(ctx.plugin.i18n as Record<string, unknown>, key, values);
  }

  private config(ctx: FeatureContext): ImageFeatureConfig {
    return ctx.settings.getFeature<ImageFeatureConfig>(this.meta.id);
  }

  private settings(ctx: FeatureContext): ImageSettings {
    return this.config(ctx).compression;
  }

  protected onEnable(ctx: FeatureContext, scope: FeatureScope): void {
    scope.own(() => this.tasks.cancelAll("Feature disabled"));
    for (const contribution of imageMenuContributions({
      scope,
      context: ctx,
      t: (key, values) => this.t(ctx, key, values),
      icon: this.meta.icon,
      label: menu => this.pageLabel(menu, ctx),
      compressImage: menu => compressSelectedImage(menu.detail, ctx, scope, this.settings(ctx), this.service),
      toggleDocument: menu => this.toggleDocument(menu, ctx, scope),
      runBatch: menu => this.runBatch(menu, ctx, scope),
    })) {
      ctx.menus.contribute(scope, this.meta.id, contribution.location, contribution.id, contribution.provider);
    }

    registerAutoUpload(ctx.plugin, scope,
      () => ctx.compatibility.supportsBeforeUpload(),
      async rootID => {
        const config = this.config(ctx);
        const featureEnabled = scope.active && ctx.settings.getFeatureEnabled(this.meta.id, true);
        const hostSupportsUpload = ctx.compatibility.supportsBeforeUpload();
        const allowlisted = Boolean(config.autoCompression.pageAllowlist[rootID]);
        const allowed = shouldAutoCompress({
          featureEnabled,
          hostSupportsUpload,
          rootID,
          globalEnabled: config.autoCompression.globalEnabled,
          allowlisted,
        });
        ctx.logger.debug("自动压缩策略检查完成", {
          rootID,
          featureEnabled,
          hostSupportsUpload,
          globalEnabled: config.autoCompression.globalEnabled,
          allowlisted,
          allowed,
        });
        return allowed;
      },
      this.service, () => this.settings(ctx), ctx.logger,
      count => showMessage(this.t(ctx, "image.autoUpload.compressed", { count }), 4000));
  }

  protected onDisable(): void {
    this.tasks.cancelAll("Feature disabled");
  }

  /** Only a kernel-confirmed document root can be added to the allowlist. */
  async resolveDocument(rootID: string, logger?: Logger): Promise<{
    ok: boolean; notebookId?: string; identity?: BlockIdentity;
  }> {
    try {
      const identity = await this.assets.getBlockIdentity(rootID);
      const ok = isDocumentRootIdentity(identity, rootID);
      logger?.debug("文档身份校验完成", { 文档根ID: rootID, 校验通过: ok });
      return { ok, identity, notebookId: typeof identity?.box === "string" ? identity.box : undefined };
    } catch (error) {
      logger?.warn("查询文档身份失败", error);
      return { ok: false };
    }
  }

  async verifyDocument(rootID: string): Promise<boolean> {
    return (await this.resolveDocument(rootID)).ok;
  }

  private async toggleDocument(menu: MenuContext, ctx: FeatureContext, scope: FeatureScope): Promise<void> {
    if (!scope.active || !menu.rootID) return;
    try {
      const verified = await this.resolveDocument(menu.rootID, ctx.logger);
      if (!scope.active) return; // @safety Async kernel response may arrive after disable.
      if (!verified.ok) {
        showMessage(this.t(ctx, "menu.notDocument"), 5000, "error");
        return;
      }
      const enabled = await this.pages.toggle(menu.rootID, {
        notebookIdSnapshot: verified.notebookId,
      });
      if (!scope.active) return;
      showMessage(this.t(ctx, enabled ? "menu.granted" : "menu.revoked"));
    } catch (error) {
      ctx.logger.error("保存文档白名单失败", error);
      if (scope.active) showMessage(this.t(ctx, "menu.saveFailed"), 5000, "error");
    }
  }

  private pageLabel(menu: MenuContext, ctx: FeatureContext): string {
    if (!menu.rootID) return this.t(ctx, "menu.resolveFailed");
    const allowed = this.pages.hasCached(menu.rootID);
    const global = this.config(ctx).autoCompression.globalEnabled;
    // @invariant Global ON cannot be overridden by removing a page from the allowlist.
    if (global) return allowed
      ? this.t(ctx, "auto.removeFallbackDocument")
      : this.t(ctx, "auto.addFallbackDocument");
    return allowed
      ? this.t(ctx, "menu.disablePage")
      : this.t(ctx, "menu.enablePage");
  }

  private async runBatch(menu: MenuContext, ctx: FeatureContext, scope: FeatureScope): Promise<void> {
    // @safety Never guess the first editor on the page. Require the same explicit document.
    const protyle = menu.detail?.protyle ?? menu.detail?.editor?.protyle;
    if (!scope.active || !menu.rootID || protyle?.block?.rootID !== menu.rootID) {
      showMessage(this.t(ctx, "image.batch.invalidDocument"), 5000, "error");
      return;
    }
    const controller = this.tasks.create(scope.signal);
    const dialog = document.createElement("dialog");
    dialog.className = "omnikit-dialog omnikit-progress-dialog";
    const heading = document.createElement("h3");
    heading.textContent = this.t(ctx, "batch.running");
    const progress = document.createElement("progress");
    progress.max = 1;
    const status = document.createElement("p");
    status.setAttribute("aria-live", "polite");
    const cancel = document.createElement("button");
    cancel.className = "b3-button b3-button--outline";
    cancel.textContent = this.t(ctx, "batch.cancel");
    cancel.onclick = () => controller.abort("User cancelled");
    dialog.append(heading, progress, status, cancel);
    scope.own(() => dialog.remove());
    document.body.append(dialog);
    if (typeof dialog.showModal === "function") dialog.showModal();
    else dialog.setAttribute("open", "");
    try {
      const result = await compressDocumentImages(menu.detail, ctx, scope,
        this.settings(ctx), this.service, {
          signal: controller.signal,
          onProgress: update => {
            if (!scope.active) return;
            progress.max = Math.max(1, update.total);
            progress.value = update.completed;
            status.textContent = `${update.completed}/${update.total}`;
          },
        });
      if (scope.active) {
        heading.textContent = this.t(ctx, result.cancelled ? "batch.cancelled" : "batch.done");
        status.textContent = `${result.succeeded} / ${result.total}`;
      }
    } catch (error) {
      ctx.logger.error("批量压缩文档图片失败", error);
      if (scope.active) heading.textContent = this.t(ctx, "batch.failed");
    } finally {
      controller.abort("Batch complete");
      this.tasks.release(controller);
      if (scope.active) {
        cancel.textContent = this.t(ctx, "batch.close");
        cancel.onclick = () => dialog.close();
      }
    }
  }
}
