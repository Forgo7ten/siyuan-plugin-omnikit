import { getAllEditor } from "siyuan";
import { BaseFeature } from "../../core/framework/BaseFeature.ts";
import type { FeatureContext } from "../../core/framework/FeatureContext.ts";
import type { FeatureScope } from "../../core/framework/FeatureScope.ts";
import type { MenuContext } from "../../core/feedback/MenuRegistry.ts";
import type { SettingsManager } from "../../core/store/SettingsManager.ts";
import { KernelClient } from "../../core/host/KernelClient.ts";
import { getCurrentFrontend } from "../../core/host/Platform.ts";
import { listEditorsSafe, resolveProtyleElement } from "../../core/host/ProtyleAdapter.ts";
import { isInsideProtectedContainer } from "../../core/host/dom.ts";
import { translate } from "../../i18n/translate.ts";
import type { TitledLinkConfig } from "./policy/types.ts";
import { PasteLinkCapture } from "./services/PasteLinkCapture.ts";
import { TitledLinkController, isHttpUrl } from "./TitledLinkController.ts";

export interface TitledLinkFeatureOptions {
  now?: () => number;
}

interface CompositionState {
  since: number;
  composing: boolean;
}

const COMPOSITION_STALE_MS = 10_000;

/** Host adapter for titled-link; all listeners and editor composition hooks belong to its scope. */
export class TitledLinkFeature extends BaseFeature {
  static readonly ID = "titled-link";
  private controller?: TitledLinkController;
  private logger?: FeatureContext["logger"];
  private readonly kernel = new KernelClient();
  private readonly composingEditors = new Map<HTMLElement, CompositionState>();
  private readonly now: () => number;

  constructor(
    plugin: FeatureContext["plugin"],
    settings: SettingsManager,
    options: TitledLinkFeatureOptions = {},
  ) {
    super({
      id: TitledLinkFeature.ID,
      title: translate(plugin.i18n as Record<string, unknown>, "feature.titledLink.title"),
      description: translate(plugin.i18n as Record<string, unknown>, "feature.titledLink.description"),
      category: "text",
      icon: "iconLink",
      defaultEnabled: true,
      minimumAppVersion: "3.8.4",
      frontends: ["all"],
    });
    this.now = options.now ?? Date.now;
    // Ensure the registered feature settings file stays aligned with its storage contract.
    settings.store(TitledLinkFeature.ID);
  }

  protected onEnable(context: FeatureContext, scope: FeatureScope): void {
    this.logger = context.logger;
    const t = (key: string, values?: Record<string, string | number>) =>
      translate(context.plugin.i18n as Record<string, unknown>, key, values);
    const isComposing = (protyle?: unknown): boolean => {
      const editor = resolveProtyleElement(protyle);
      if (!editor) return false;
      const entry = this.composingEditors.get(editor);
      if (!entry) return false;
      if (editor.isConnected === false) {
        context.logger?.debug?.("编辑器已脱离文档，忽略 IME 输入态");
        return false;
      }
      if (entry.composing) {
        const elapsedMs = this.now() - entry.since;
        if (elapsedMs > COMPOSITION_STALE_MS) {
          context.logger?.debug?.("IME 输入态已超时，按非输入态放行", {
            elapsedMs,
            staleMs: COMPOSITION_STALE_MS,
          });
          return false;
        }
      }
      return entry.composing;
    };
    const controller = new TitledLinkController(context, scope, {
      kernel: this.kernel,
      notify: message => context.feedback.notify(message, "info", { timeout: 3000 }),
      frontend: () => getCurrentFrontend(),
      isComposing,
      translate: t,
    });
    this.controller = controller;
    const pasteCapture = new PasteLinkCapture({
      plugin: context.plugin,
      scope,
      isEnabled: () => scope.active && context.settings.getFeature<TitledLinkConfig>(TitledLinkFeature.ID).auto.enabled,
      isComposing,
      onLinksCaptured: (links, protyle) => controller.runAutoPaste(links, protyle),
      logger: context.logger,
    });
    scope.own(() => {
      pasteCapture.dispose();
      for (const editor of this.composingEditors.keys()) {
        editor.removeEventListener("compositionstart", this.onCompositionStart, { capture: true });
        editor.removeEventListener("compositionend", this.onCompositionEnd, { capture: true });
      }
      this.composingEditors.clear();
      controller.clear();
      if (this.controller === controller) this.controller = undefined;
    });

    const registerEditor = (protyle: unknown) => {
      this.attachCompositionTracking(resolveProtyleElement(protyle));
      pasteCapture.attach(protyle);
    };

    for (const editor of listEditorsSafe(getAllEditor, context.logger)) {
      registerEditor(editor);
    }

    const onLinkMenu = (menu: MenuContext) => {
      const detail = menu.detail;
      const link = detail?.element as HTMLElement | undefined;
      const protyle = detail?.protyle;
      registerEditor(protyle);
      const isLink = link?.getAttribute?.("data-type")?.split(" ").includes("a") === true;
      const href = link?.getAttribute?.("data-href");
      const isHttp = isHttpUrl(href ?? "");
      const inProtected = link ? isInsideProtectedContainer(link) : false;
      if (!link || !isLink || !protyle || !isHttp || inProtected) {
        context.logger?.debug("链接菜单跳过生成提取标题项", {
          hasLink: Boolean(link),
          isLink,
          isHttp,
          inProtected,
          hasProtyle: Boolean(protyle),
        });
        return [];
      }
      const text = link.textContent;
      context.logger?.debug("生成链接菜单项：提取链接标题", { href, text });
      return [{
        id: "extract-link-title",
        label: t("titledLink.menuSingle"),
        icon: "iconLink",
        run: async () => {
          context.logger?.debug("触发链接菜单项：提取链接标题", { href, text });
          await controller.runManual(link, protyle);
        },
      }];
    };
    context.menus.contribute(scope, this.meta.id, "link", "extract-link-title", onLinkMenu);

    const onBlockMenu = (menu: MenuContext) => {
      const detail = menu.detail;
      const protyle = detail?.protyle;
      const blocks = Array.isArray(detail?.blockElements) ? detail.blockElements as HTMLElement[] : [];
      registerEditor(protyle);
      const count = new Set(blocks.flatMap(block =>
        [...block.querySelectorAll<HTMLElement>('span[data-type~="a"]')])
        .filter(link => isHttpUrl(link.getAttribute("data-href") ?? "") && !isInsideProtectedContainer(link))).size;
      if (!count || !protyle) {
        context.logger?.debug("块菜单跳过生成批量提取链接标题项", {
          blockCount: blocks.length,
          httpLinkCount: count,
          hasProtyle: Boolean(protyle),
        });
        return [];
      }
      context.logger?.debug("生成块菜单项：批量提取链接标题", { blockCount: blocks.length, httpLinkCount: count });
      return [{
        id: "extract-block-link-titles",
        label: t("titledLink.menuBatch", { count }),
        icon: "iconLink",
        run: async () => {
          context.logger?.debug("触发块菜单项：批量提取链接标题", { blockCount: blocks.length, httpLinkCount: count });
          await controller.runBatch(blocks, protyle);
        },
      }];
    };
    context.menus.contribute(scope, this.meta.id, "blockicon", "extract-block-link-titles", onBlockMenu);

    const onEditor = (event: CustomEvent<any>) => registerEditor(event.detail?.protyle);
    for (const name of ["loaded-protyle-static", "switch-protyle"] as const) {
      context.plugin.eventBus.on(name, onEditor);
      scope.own(() => context.plugin.eventBus.off(name, onEditor));
    }

    const onDestroyProtyle = (event: CustomEvent<any>) => {
      const protyle = event.detail?.protyle;
      const editor = resolveProtyleElement(protyle);
      if (editor && this.composingEditors.has(editor)) {
        editor.removeEventListener("compositionstart", this.onCompositionStart, { capture: true });
        editor.removeEventListener("compositionend", this.onCompositionEnd, { capture: true });
        this.composingEditors.delete(editor);
      }
      pasteCapture.detach(protyle);
    };
    context.plugin.eventBus.on("destroy-protyle", onDestroyProtyle);
    scope.own(() => context.plugin.eventBus.off("destroy-protyle", onDestroyProtyle));
  }

  protected onDisable(): void {
    this.controller?.clear();
    this.controller = undefined;
    this.logger = undefined;
  }

  protected onSettingsChanged(): void {
    this.logger?.debug?.("配置变更，清空链接标题缓存");
    this.controller?.clear();
  }

  private readonly onCompositionStart = (event: Event): void => {
    const editor = event.currentTarget;
    if (editor instanceof HTMLElement) {
      this.composingEditors.set(editor, { since: this.now(), composing: true });
    }
  };

  private readonly onCompositionEnd = (event: Event): void => {
    const editor = event.currentTarget;
    if (editor instanceof HTMLElement) {
      this.composingEditors.set(editor, { since: this.now(), composing: false });
    }
  };

  private attachCompositionTracking(editor: unknown): void {
    if (!(editor instanceof HTMLElement) || this.composingEditors.has(editor)) return;
    this.composingEditors.set(editor, { since: 0, composing: false });
    // SiYuan's wysiwyg element calls stopPropagation() on compositionstart/end in the bubble phase.
    editor.addEventListener("compositionstart", this.onCompositionStart, { capture: true });
    editor.addEventListener("compositionend", this.onCompositionEnd, { capture: true });
  }
}
