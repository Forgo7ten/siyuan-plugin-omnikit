import { Menu, getActiveEditor, getFrontend, type Plugin } from "siyuan";
import type { MenuRegistry } from "../../core/MenuRegistry.ts";

export interface TopBarOptions {
  title: string;
  menus: MenuRegistry;
  openSettings: () => void;
}

/**
 * @design OmniKit owns one stable TopBar icon. Features contribute ephemeral menu items.
 * @invariant Feature OFF means no entry appears when the menu is opened again.
 */
export function registerTopBar(plugin: Plugin, options: TopBarOptions): void {
  const open = (rect?: DOMRect): void => {
    const menu = new Menu("omnikit-core-menu");
    menu.addItem({
      id: "omnikit-open-settings",
      icon: "iconSettings",
      label: options.title,
      click: options.openSettings,
    });
    const protyle = (getActiveEditor() as any)?.protyle;
    const rootID = protyle?.block?.rootID as string | undefined;
    options.menus.render("topbar", menu, {
      location: "topbar", rootID,
      selectedDocumentCount: rootID ? 1 : 0,
      detail: { protyle },
    });
    const frontend = getFrontend();
    if (frontend === "mobile" || frontend === "browser-mobile") {
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
      menu.addItem({ icon: "iconSettings", label: options.title, click: options.openSettings });
      const protyle = (getActiveEditor() as any)?.protyle;
      const rootID = protyle?.block?.rootID;
      options.menus.render("topbar", menu, {
        location: "topbar", rootID, selectedDocumentCount: rootID ? 1 : 0,
        detail: { protyle },
      });
    },
  });
}
