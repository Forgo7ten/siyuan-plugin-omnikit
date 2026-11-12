import { showMessage } from "siyuan";
import { BaseFeature } from "../../core/BaseFeature.ts";
import type { FeatureContext } from "../../core/FeatureContext.ts";
import type { FeatureScope } from "../../core/FeatureScope.ts";
import type { MenuContext } from "../../core/MenuRegistry.ts";
import type { SettingsManager } from "../../core/SettingsManager.ts";
import type { Logger } from "../../core/Logger.ts";
import { PageAllowlist } from "./PageAllowlist.ts";
import { isDocumentRootIdentity, type BlockIdentity } from "./DocumentIdentity.ts";
import { KernelClient } from "../../core/KernelClient.ts";
import { NODE_ID } from "./parseImageConfig.ts";
import { TaskRegistry } from "./TaskRegistry.ts";
import { IMAGE_FEATURE_ID } from "./settings.ts";
import type { ImageFeatureConfig } from "./registration.ts";
import { registerAutoUpload, type AutoUploadNotice } from "./AutoUploadHandler.ts";
import { shouldAutoCompress } from "./AutoPolicy.ts";
import { imageMenuContributions } from "./menuContributions.ts";
import { type SingleImageEditorContext } from "./SingleImageAction.ts";
import { ImageController } from "./ImageController.ts";
import { translate } from "../../i18n/translate.ts";
import { createImageServices } from "./createImageServices.ts";
import type { ImageProcessingServices } from "./ImageProcessingServices.ts";
import { resolveSource } from "./source.ts";
import { watchRemoteImages, type RemoteWatcherHandle } from "./RemoteImageWatcher.ts";
import type { DocumentRow } from "./references.ts";

/**
 * @invariant The feature owns all business registrations through FeatureScope.
 * @safety Disabling the feature immediately removes menus/auto upload and cancels
 * remaining compressions; the original asset is never deleted.
 */
export class ImageCompressorFeature extends BaseFeature {
  static readonly ID = IMAGE_FEATURE_ID;
  readonly pages: PageAllowlist;
  private readonly tasks = new TaskRegistry();
  private readonly kernel = new KernelClient();
  private controller?: ImageController;

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

  protected onEnable(ctx: FeatureContext, scope: FeatureScope): void {
    const services = createImageServices(ctx, scope);
    const controller = new ImageController(ctx, scope, services, this.tasks);
    this.controller = controller;

    scope.own(() => {
      this.tasks.cancelAll("Feature disabled");
      this.controller = undefined;
    });

    for (const contribution of imageMenuContributions({
      scope,
      context: ctx,
      t: (key, values) => this.t(ctx, key, values),
      icon: this.meta.icon,
      label: menu => this.pageLabel(menu, ctx),
      compressImage: menu => this.runSingle(menu, ctx, scope, services, controller),
      compressFromFile: menu => this.runSingleFromFile(menu, ctx, scope, services, controller),
      toggleDocument: menu => this.toggleDocument(menu, ctx, scope),
      runBatch: menu => this.runBatch(menu, controller),
    })) {
      ctx.menus.contribute(scope, this.meta.id, contribution.location, contribution.id, contribution.provider);
    }

    registerAutoUpload(ctx.plugin, scope,
      () => ctx.compatibility.supportsBeforeUpload(),
      async rootID => {
        const config = this.config(ctx);
        const featureEnabled = scope.active && ctx.settings.getFeatureEnabled(this.meta.id, true);
        const hostSupportsUpload = ctx.compatibility.supportsBeforeUpload();
        const allowlisted = Boolean(config.auto.pageAllowlist[rootID]);
        const allowed = config.auto.uploads && shouldAutoCompress({
          featureEnabled,
          hostSupportsUpload,
          rootID,
          globalEnabled: config.auto.globalEnabled,
          allowlisted,
        });
        ctx.logger.debug("自动压缩策略检查完成", {
          rootID,
          featureEnabled,
          hostSupportsUpload,
          globalEnabled: config.auto.globalEnabled,
          allowlisted,
          allowed,
        });
        return allowed;
      },
      services, ctx.logger,
      notice => this.showAutoUploadNotice(ctx, scope, notice));
    this.installRemoteWatchers(ctx, scope, services);
  }

  private installRemoteWatchers(ctx: FeatureContext, scope: FeatureScope, services: ImageProcessingServices): void {
    type EditorEntry = { rootID: string; notebook: string; handle?: RemoteWatcherHandle };
    const editors = new Map<HTMLElement, EditorEntry>();
    let syncing = false;
    const attach = (protyle: any) => {
      const element = protyle?.element;
      const rootID = protyle?.block?.rootID;
      const notebook = protyle?.notebookId ?? protyle?.block?.box;
      if (!(element instanceof HTMLElement) || typeof rootID !== "string" || typeof notebook !== "string" || protyle.disabled) return;
      const prior = editors.get(element);
      prior?.handle?.dispose();
      const entry: EditorEntry = { rootID, notebook };
      editors.set(element, entry);
      const doc: DocumentRow = { id: rootID, root_id: rootID, box: notebook };
      void watchRemoteImages(element, doc, scope, services, {
        warn: (message, data) => ctx.logger.warn(message, data),
      }).then(handle => {
        if (!scope.active || editors.get(element) !== entry) handle.dispose();
        else { entry.handle = handle; if (syncing) handle.pause(); }
      }).catch(error => ctx.logger.warn("建立外链图片观察失败", error));
    };
    const onEditor = (event: CustomEvent<any>) => attach(event.detail?.protyle);
    const onDestroyed = (event: CustomEvent<any>) => {
      const element = event.detail?.protyle?.element;
      if (element instanceof HTMLElement) {
        editors.get(element)?.handle?.dispose();
        editors.delete(element);
      }
    };
    const onSyncStart = () => { syncing = true; for (const entry of editors.values()) entry.handle?.pause(); };
    const onSyncEnd = () => { syncing = false; for (const entry of editors.values()) entry.handle?.resume(); };
    for (const [name, handler] of [
      ["loaded-protyle-static", onEditor], ["switch-protyle", onEditor],
      ["destroy-protyle", onDestroyed], ["sync-start", onSyncStart],
      ["sync-end", onSyncEnd], ["sync-fail", onSyncEnd],
    ] as const) {
      ctx.plugin.eventBus.on(name, handler);
      scope.own(() => ctx.plugin.eventBus.off(name, handler));
    }
    scope.own(() => { for (const entry of editors.values()) entry.handle?.dispose(); editors.clear(); });
  }

  private showAutoUploadNotice(ctx: FeatureContext, scope: FeatureScope, notice: AutoUploadNotice): void {
    if (!scope.active) return;
    const values = { count: notice.count };
    const key = `image.autoUpload.${notice.status}`;
    const message = this.t(ctx, key, values);
    if (notice.status === "partial" || notice.status === "failed") showMessage(message, 5000, "error");
    else showMessage(message, 4000);
  }

  protected onDisable(): void {
    this.tasks.cancelAll("Feature disabled");
  }

  /** Only a kernel-confirmed document root can be added to the allowlist. */
  async resolveDocument(rootID: string, logger?: Logger): Promise<{
    ok: boolean; notebookId?: string; identity?: BlockIdentity;
  }> {
    try {
      if (!NODE_ID.test(rootID)) return { ok: false };
      const rows = (await this.kernel.post<Array<{ id: string; type: string; box: string; rootID: string }>>("/api/query/sql", {
        stmt: `SELECT id, type, box, root_id AS rootID FROM blocks WHERE id = '${rootID}' LIMIT 1`,
        mode: "readonly",
      })).data;
      const identity = Array.isArray(rows) ? rows[0] : undefined;
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
      const enabled = await this.pages.toggle(menu.rootID);
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
    const global = this.config(ctx).auto.globalEnabled;
    // @invariant Global ON cannot be overridden by removing a page from the allowlist.
    if (global) return allowed
      ? this.t(ctx, "auto.removeFallbackDocument")
      : this.t(ctx, "auto.addFallbackDocument");
    return allowed
      ? this.t(ctx, "menu.disablePage")
      : this.t(ctx, "menu.enablePage");
  }

  private editor(menu: MenuContext): SingleImageEditorContext | undefined {
    const protyle = menu.detail?.protyle ?? menu.detail?.editor?.protyle;
    const rootID = protyle?.block?.rootID;
    const notebook = protyle?.notebookId ?? protyle?.block?.box;
    if (typeof rootID !== "string" || typeof notebook !== "string" || rootID !== menu.rootID) return undefined;
    return { rootID, notebook, disabled: protyle?.disabled === true };
  }

  private async runSingle(
    menu: MenuContext,
    ctx: FeatureContext,
    scope: FeatureScope,
    services: ImageProcessingServices,
    controller: ImageController,
  ): Promise<void> {
    const editor = this.editor(menu);
    if (!editor) { showMessage(this.t(ctx, "image.single.invalidTarget"), 5000, "error"); return; }
    await controller.compressSingle(menu.detail, editor);
  }

  private async runSingleFromFile(
    menu: MenuContext,
    ctx: FeatureContext,
    scope: FeatureScope,
    services: ImageProcessingServices,
    controller: ImageController,
  ): Promise<void> {
    const editor = this.editor(menu);
    if (!editor || !menu.imageURL) { showMessage(this.t(ctx, "image.single.invalidTarget"), 5000, "error"); return; }
    let name = "image";
    try { name = resolveSource(menu.imageURL, services.origin).name; } catch { /* choose explicitly */ }
    const file = await services.ui.pickImage(name, scope.signal);
    if (file) await controller.compressSingleFromFile(menu.detail, editor, file);
  }

  private async runBatch(menu: MenuContext, controller: ImageController): Promise<void> {
    if (!menu.rootID) return;
    await controller.compressDocument(menu.detail, menu.rootID);
  }
}
