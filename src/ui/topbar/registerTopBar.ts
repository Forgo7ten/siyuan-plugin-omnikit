import { Menu, getActiveEditor, getAllModels, type Plugin } from "siyuan";
import type { HostMenu, MenuRegistry } from "../../core/feedback/MenuRegistry.ts";
import { isMobileFrontend } from "../../core/host/Platform.ts";

export interface TopBarOptions {
  title: string;
  menus: MenuRegistry;
  openSettings: () => void;
}

function resolveActiveDocumentProtyle(): any {
  if (isMobileFrontend()) {
    return (getActiveEditor() as any)?.protyle;
  }
  const modelsGetter = typeof getAllModels === "function" ? getAllModels : undefined;
  const editorModels: Array<{ editor?: any; parent?: any }> = modelsGetter?.()?.editor ?? [];
  if (editorModels.length === 0) {
    return (getActiveEditor() as any)?.protyle;
  }
  const mainEditors = new Set(editorModels.map(m => m?.editor).filter(Boolean));
  const direct = getActiveEditor();
  if (direct && mainEditors.has(direct)) {
    return (direct as any).protyle;
  }
  let bestProtyle: any;
  let bestTime = -1;
  for (const model of editorModels) {
    const protyle = model?.editor?.protyle;
    const el = protyle?.element as HTMLElement | undefined;
    if (!el || el.classList?.contains("fn__none")) continue;
    const head = protyle?.model?.headElement ?? model?.parent?.headElement;
    if (head?.classList && !head.classList.contains("item--focus")) continue;
    const activeTime = Number(head?.dataset?.activetime ?? 0) || 0;
    if (bestProtyle === undefined || activeTime > bestTime) {
      bestTime = activeTime;
      bestProtyle = protyle;
    }
  }
  return bestProtyle;
}

/**
 * @design OmniKit owns one stable TopBar icon. Features contribute ephemeral menu items.
 * @invariant Feature OFF means no entry appears when the menu is opened again.
 */
export function registerTopBar(plugin: Plugin, options: TopBarOptions): void {
  const addSettingsItem = (menu: HostMenu): void => {
    menu.addItem({
      id: "omnikit-open-settings",
      icon: "iconSettings",
      label: options.title,
      click: options.openSettings,
    });
  };
  const renderTopBarItems = (menu: HostMenu): number => {
    const protyle = resolveActiveDocumentProtyle();
    const rootID = protyle?.block?.rootID as string | undefined;
    return options.menus.render("topbar", menu, {
      location: "topbar",
      rootID,
      protyle,
      detail: { protyle },
    });
  };

  const open = (rect?: DOMRect): void => {
    const menu = new Menu("omnikit-core-menu");
    addSettingsItem(menu);
    const sep = menu.addSeparator({ id: "separator_settings" });
    if (renderTopBarItems(menu) === 0) {
      sep?.remove();
    }
    if (isMobileFrontend()) {
      menu.fullscreen();
    } else {
      // @compat Desktop Menu.open expects a concrete anchor position.
      menu.open({
        x: rect?.right ?? Math.max(0, window.innerWidth - 40),
        y: rect?.bottom ?? 32,
        isLeft: true,
      });
    }
  };

  const element = plugin.addTopBar({
    id: "omnikit-core",
    icon: "iconOmnikitMenu",
    title: "OmniKit",
    position: "right",
    callback: () => {
      const directRect = element?.getBoundingClientRect();
      const fallback = document.querySelector<HTMLElement>("#barMore") ??
        document.querySelector<HTMLElement>("#barPlugins");
      const rect = directRect && directRect.width > 0 ? directRect : fallback?.getBoundingClientRect();
      open(rect?.width ? rect : undefined);
    },
    contextMenu: menu => {
      addSettingsItem(menu);
      menu.addSeparator(undefined, "separator_settings");
      renderTopBarItems(menu);
    },
  });
}
