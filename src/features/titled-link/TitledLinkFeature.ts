import { getFrontend, showMessage } from "siyuan";
import { BaseFeature } from "../../core/BaseFeature.ts";
import type { FeatureContext } from "../../core/FeatureContext.ts";
import type { FeatureScope } from "../../core/FeatureScope.ts";
import type { MenuContext } from "../../core/MenuRegistry.ts";
import type { SettingsManager } from "../../core/SettingsManager.ts";
import { KernelClient } from "../../core/KernelClient.ts";
import { translate } from "../../i18n/translate.ts";
import { TitledLinkController } from "./TitledLinkController.ts";
import { isHttpUrl } from "./TitledLinkController.ts";

/** Host adapter for titled-link; all listeners and editor composition hooks belong to its scope. */
export class TitledLinkFeature extends BaseFeature {
  static readonly ID = "titled-link";
  private controller?: TitledLinkController;
  private readonly kernel = new KernelClient();
  private readonly composingEditors = new Map<HTMLElement, boolean>();

  constructor(plugin: FeatureContext["plugin"], settings: SettingsManager) {
    super({
      id: TitledLinkFeature.ID,
      title: translate(plugin.i18n as Record<string, unknown>, "feature.titledLink.title"),
      description: translate(plugin.i18n as Record<string, unknown>, "feature.titledLink.description"),
      category: "text",
      icon: "iconLink",
      defaultEnabled: true,
      minimumAppVersion: "3.8.0",
      frontends: ["all"],
    });
    // Ensure the registered feature settings file stays aligned with its storage contract.
    settings.store(TitledLinkFeature.ID);
  }

  protected onEnable(context: FeatureContext, scope: FeatureScope): void {
    const t = (key: string, values?: Record<string, string | number>) =>
      translate(context.plugin.i18n as Record<string, unknown>, key, values);
    const controller = new TitledLinkController(context, scope, {
      kernel: this.kernel,
      notify: message => { if (scope.active) showMessage(message, 3000); },
      frontend: () => getFrontend(),
      isComposing: () => [...this.composingEditors.values()].some(Boolean),
      translate: t,
    });
    this.controller = controller;
    scope.own(() => {
      for (const [editor, composing] of this.composingEditors) {
        editor.removeEventListener("compositionstart", this.onCompositionStart);
        editor.removeEventListener("compositionend", this.onCompositionEnd);
        if (composing) this.composingEditors.delete(editor);
      }
      this.composingEditors.clear();
      controller.clear();
      if (this.controller === controller) this.controller = undefined;
    });

    const onPaste = (event: CustomEvent<any>) => {
      const detail = event.detail;
      this.attachCompositionTracking(detail?.protyle?.element, scope);
      controller.scheduleAutoPaste(detail);
    };
    context.plugin.eventBus.on("paste", onPaste);
    scope.own(() => context.plugin.eventBus.off("paste", onPaste));

    const onLinkMenu = (menu: MenuContext) => {
      const detail = menu.detail;
      const link = detail?.element as HTMLElement | undefined;
      const protyle = detail?.protyle;
      this.attachCompositionTracking(protyle?.element, scope);
      if (!link || link.getAttribute("data-type")?.split(" ").includes("a") !== true || !protyle) return [];
      return [{
        id: "extract-link-title",
        label: t("titledLink.menuSingle"),
        icon: "iconLink",
        run: async () => { await controller.runManual(link, protyle); },
      }];
    };
    context.menus.contribute(scope, this.meta.id, "link", "extract-link-title", onLinkMenu);

    const onBlockMenu = (menu: MenuContext) => {
      const detail = menu.detail;
      const protyle = detail?.protyle;
      const blocks = Array.isArray(detail?.blockElements) ? detail.blockElements as HTMLElement[] : [];
      this.attachCompositionTracking(protyle?.element, scope);
      const count = new Set(blocks.flatMap(block =>
        [...block.querySelectorAll<HTMLElement>('span[data-type~="a"]')])
        .filter(link => isHttpUrl(link.getAttribute("data-href") ?? ""))).size;
      if (!count || !protyle) return [];
      return [{
        id: "extract-block-link-titles",
        label: t("titledLink.menuBatch", { count }),
        icon: "iconLink",
        run: async () => { await controller.runBatch(blocks, protyle); },
      }];
    };
    context.menus.contribute(scope, this.meta.id, "blockicon", "extract-block-link-titles", onBlockMenu);

    const onEditor = (event: CustomEvent<any>) => this.attachCompositionTracking(event.detail?.protyle?.element, scope);
    for (const name of ["loaded-protyle-static", "switch-protyle"] as const) {
      context.plugin.eventBus.on(name, onEditor);
      scope.own(() => context.plugin.eventBus.off(name, onEditor));
    }
  }

  protected onDisable(): void {
    this.controller?.clear();
    this.controller = undefined;
  }

  private readonly onCompositionStart = (event: Event): void => {
    const editor = event.currentTarget;
    if (editor instanceof HTMLElement) this.composingEditors.set(editor, true);
  };

  private readonly onCompositionEnd = (event: Event): void => {
    const editor = event.currentTarget;
    if (editor instanceof HTMLElement) this.composingEditors.set(editor, false);
  };

  private attachCompositionTracking(editor: unknown, scope: FeatureScope): void {
    if (!(editor instanceof HTMLElement) || this.composingEditors.has(editor)) return;
    this.composingEditors.set(editor, false);
    editor.addEventListener("compositionstart", this.onCompositionStart);
    editor.addEventListener("compositionend", this.onCompositionEnd);
    scope.own(() => {
      editor.removeEventListener("compositionstart", this.onCompositionStart);
      editor.removeEventListener("compositionend", this.onCompositionEnd);
      this.composingEditors.delete(editor);
    });
  }
}
