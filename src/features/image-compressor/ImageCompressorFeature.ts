import { getActiveEditor, getAllEditor } from "siyuan";
import { BaseFeature } from "../../core/framework/BaseFeature.ts";
import type { FeatureContext } from "../../core/framework/FeatureContext.ts";
import type { FeatureScope } from "../../core/framework/FeatureScope.ts";
import type { MenuContext } from "../../core/feedback/MenuRegistry.ts";
import { isAbortError } from "../../core/feedback/UiFeedback.ts";
import type { SettingsManager } from "../../core/store/SettingsManager.ts";
import type { Logger } from "../../core/host/Logger.ts";
import { PageAllowlist } from "./policy/PageAllowlist.ts";
import { isDocumentRootIdentity } from "./policy/DocumentIdentity.ts";
import { KernelClient } from "../../core/host/KernelClient.ts";
import {
  listEditorsSafe,
  resolveEditorRootID,
  resolveNotebookID,
  resolveProtyleElement,
} from "../../core/host/ProtyleAdapter.ts";
import { autoAllowed, IMAGE_FEATURE_ID, NODE_ID } from "./policy/parseImageConfig.ts";
import { TaskRegistry } from "./policy/TaskRegistry.ts";
import type { ImageFeatureConfig } from "./registration.ts";
import { registerAutoUpload } from "./actions/AutoUploadHandler.ts";
import { imageMenuContributions } from "./actions/menuContributions.ts";
import { type SingleImageEditorContext } from "./actions/SingleImageAction.ts";
import { ImageController } from "./ImageController.ts";
import { translate } from "../../i18n/translate.ts";
import { createImageServices } from "./services/createImageServices.ts";
import type { ImageProcessingServices } from "./services/ImageProcessingServices.ts";
import { watchRemoteImages, type DocumentRow, type RemoteWatcherHandle } from "./actions/RemoteImageWatcher.ts";

export type ResolveDocumentResult = { status: "ok" | "invalid" | "error" | "aborted" };

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
      minimumAppVersion: "3.8.4",
      frontends: ["all"],
    });
    this.pages = new PageAllowlist(settings);
  }

  private t(ctx: FeatureContext, key: string, values: Record<string, string | number> = {}): string {
    return translate(ctx.plugin.i18n as Record<string, unknown>, key, values);
  }

  private notify(ctx: FeatureContext, message: string, type: "info" | "error" = "info", timeout?: number): void {
    ctx.feedback.notify(message, type, timeout === undefined ? undefined : { timeout });
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
      t: (key, values) => this.t(ctx, key, values),
      icon: this.meta.icon,
      isAllowlisted: menu => Boolean(menu.rootID && this.pages.hasCached(menu.rootID)),
      compressQuick: menu => this.runSingle(menu, ctx, controller),
      compressCustom: menu => this.runSingleCustom(menu, ctx, controller),
      toggleDocument: menu => this.toggleDocument(menu, ctx, scope),
      runBatch: menu => this.runBatch(menu, controller),
    })) {
      ctx.menus.contribute(scope, this.meta.id, contribution.location, contribution.id, contribution.provider);
    }

    registerAutoUpload(ctx.plugin, scope,
      rootID => {
        const config = this.config(ctx);
        const featureEnabled = scope.active && ctx.settings.getFeatureEnabled(this.meta.id, this.meta.defaultEnabled);
        const allowlisted = Boolean(config.auto.pageAllowlist[rootID]);
        const allowed = autoAllowed(config, rootID, featureEnabled);
        ctx.logger.debug("自动压缩策略检查完成", {
          rootID,
          featureEnabled,
          globalEnabled: config.auto.globalEnabled,
          allowlisted,
          allowed,
        });
        return allowed;
      },
      services, ctx.logger,
      notice => controller.reportAutoUploadNotice(notice));
    this.installRemoteWatchers(ctx, scope, services, controller);
  }

  private installRemoteWatchers(
    ctx: FeatureContext,
    scope: FeatureScope,
    services: ImageProcessingServices,
    controller: ImageController,
  ): void {
    type EditorEntry = {
      rootID: string;
      notebook: string;
      initAbort: AbortController;
      handle?: RemoteWatcherHandle;
    };
    const editors = new Map<HTMLElement, EditorEntry>();
    let syncing = false;
    const disposeEntry = (entry: EditorEntry | undefined) => {
      entry?.initAbort.abort();
      entry?.handle?.dispose();
    };
    const attach = (protyle: any) => {
      const element = resolveProtyleElement(protyle);
      if (!element) return;
      const rootID = resolveEditorRootID(protyle);
      const notebook = resolveNotebookID(protyle);
      if (!rootID || !notebook || protyle?.disabled) {
        disposeEntry(editors.get(element));
        editors.delete(element);
        return;
      }
      const prior = editors.get(element);
      if (prior && prior.rootID === rootID && prior.notebook === notebook) {
        if (prior.handle) void prior.handle.reconcile();
        return;
      }
      disposeEntry(prior);
      const entry: EditorEntry = { rootID, notebook, initAbort: new AbortController() };
      editors.set(element, entry);
      const doc: DocumentRow = { id: rootID, box: notebook };
      void watchRemoteImages(element, doc, scope, services, {
        warn: (message, data) => ctx.logger.warn(message, data),
        debug: (message, data) => ctx.logger.debug(message, data),
      }, entry.initAbort.signal, notice => controller.reportAutoUploadNotice(notice)).then(handle => {
        if (!scope.active || editors.get(element) !== entry) {
          handle.dispose();
        } else {
          entry.handle = handle;
          if (syncing) handle.pause();
        }
      }).catch(error => ctx.logger.warn("建立外链图片观察失败", error));
    };
    const onEditor = (event: CustomEvent<any>) => attach(event.detail?.protyle);
    const onDestroyed = (event: CustomEvent<any>) => {
      const element = resolveProtyleElement(event);
      if (element) {
        disposeEntry(editors.get(element));
        editors.delete(element);
      } else {
        const destroyedRootID = resolveEditorRootID(event);
        if (destroyedRootID) {
          for (const [el, entry] of editors.entries()) {
            if (entry.rootID === destroyedRootID) {
              disposeEntry(entry);
              editors.delete(el);
            }
          }
        }
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
    scope.own(() => { for (const entry of editors.values()) disposeEntry(entry); editors.clear(); });

    for (const editor of listEditorsSafe(getAllEditor, ctx.logger)) {
      const protyle = (editor as any)?.protyle;
      if (protyle) attach(protyle);
    }

    const unsubscribe = ctx.settings.store<ImageFeatureConfig>(this.meta.id).subscribe(() => {
      for (const entry of editors.values()) {
        void entry.handle?.reconcile();
      }
    });
    scope.own(unsubscribe);
  }

  /** Only a kernel-confirmed document root can be added to the allowlist. */
  async resolveDocument(rootID: string, logger?: Logger, notebookId?: string, signal?: AbortSignal): Promise<ResolveDocumentResult> {
    if (!NODE_ID.test(rootID)) return { status: "invalid" };
    if (signal?.aborted) return { status: "aborted" };
    try {
      const payload = notebookId ? { id: rootID, notebook: notebookId } : { id: rootID };
      const data = (await this.kernel.post<{
        id?: string; type?: string; box?: string; rootID?: string;
      }>("/api/block/getBlockInfo", payload, signal ? { signal } : undefined)).data;
      const identity = data
        ? { id: data.id, type: data.type, box: data.box, rootID: data.rootID }
        : undefined;
      const ok = isDocumentRootIdentity(identity, rootID);
      logger?.debug("文档身份校验完成", { 文档根ID: rootID, 校验通过: ok });
      return { status: ok ? "ok" : "invalid" };
    } catch (error) {
      if (signal?.aborted || isAbortError(error)) {
        return { status: "aborted" };
      }
      logger?.warn("查询文档身份失败", error);
      return { status: "error" };
    }
  }

  private async toggleDocument(menu: MenuContext, ctx: FeatureContext, scope: FeatureScope): Promise<void> {
    if (!scope.active || scope.signal.aborted || !menu.rootID) return;
    try {
      const detail = menu.detail;
      const notebookId = resolveNotebookID(detail);
      const verified = await this.resolveDocument(menu.rootID, ctx.logger, notebookId, scope.signal);
      if (!scope.active || scope.signal.aborted || verified.status === "aborted") return;
      if (verified.status === "error") {
        this.notify(ctx, this.t(ctx, "menu.resolveFailed"), "error", 5000);
        return;
      }
      if (verified.status === "invalid") {
        this.notify(ctx, this.t(ctx, "menu.notDocument"), "error", 5000);
        return;
      }
      const enabled = await this.pages.toggle(menu.rootID);
      if (!scope.active || scope.signal.aborted) return;
      this.notify(ctx, this.t(ctx, enabled ? "menu.granted" : "menu.revoked"));
    } catch (error) {
      if (!scope.active || scope.signal.aborted || isAbortError(error)) return;
      ctx.logger.error("保存文档白名单失败", error);
      this.notify(ctx, this.t(ctx, "menu.saveFailed"), "error", 5000);
    }
  }

  private editor(menu: MenuContext): SingleImageEditorContext | undefined {
    const protyle = menu.detail?.protyle;
    const rootID = resolveEditorRootID(protyle);
    const notebook = resolveNotebookID(protyle);
    if (!rootID || !notebook || rootID !== menu.rootID) return undefined;
    return { rootID, notebook, disabled: protyle?.disabled === true };
  }

  private async runSingle(
    menu: MenuContext,
    ctx: FeatureContext,
    controller: ImageController,
  ): Promise<void> {
    const editor = this.editor(menu);
    if (!editor) { this.notify(ctx, this.t(ctx, "image.single.invalidTarget"), "error", 5000); return; }
    await controller.compressSingleQuick(menu.detail, editor);
  }

  private async runSingleCustom(
    menu: MenuContext,
    ctx: FeatureContext,
    controller: ImageController,
  ): Promise<void> {
    const editor = this.editor(menu);
    if (!editor) { this.notify(ctx, this.t(ctx, "image.single.invalidTarget"), "error", 5000); return; }
    await controller.compressSingleCustom(menu.detail, editor);
  }

  private async runBatch(menu: MenuContext, controller: ImageController): Promise<void> {
    if (!menu.rootID) return;
    let detail = menu.detail;
    if (!detail?.protyle) {
      if (menu.protyle) {
        detail = { ...(detail && typeof detail === "object" ? detail : {}), protyle: menu.protyle };
      } else {
        try {
          const activeProtyle = (getActiveEditor() as any)?.protyle;
          if (activeProtyle?.block?.rootID === menu.rootID) {
            detail = { ...(detail && typeof detail === "object" ? detail : {}), protyle: activeProtyle };
          }
        } catch {
          // Ignore absent active editor in non-DOM/test contexts
        }
      }
    }
    await controller.compressDocument(detail, menu.rootID);
  }
}
