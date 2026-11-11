import type { Plugin } from "siyuan";
import { renderDesktopDock, type DockViewOptions } from "./DesktopDock.ts";
import { renderMobileDock } from "./MobileDock.ts";

export interface RegisterDockOptions extends DockViewOptions {
  type: string;
  icon: string;
  mobile: boolean;
}

/**
 * @design Platform differences live in the view, not in the registration path.
 * @invariant The Dock is core UI and survives every feature being disabled.
 */
export function registerDock(plugin: Plugin, options: RegisterDockOptions): () => void {
  let element: HTMLElement | undefined;

  const render = (target: HTMLElement): void => {
    if (options.mobile) renderMobileDock(target, options);
    else renderDesktopDock(target, options);
  };

  plugin.addDock({
    config: { position: "RightBottom", size: { width: 320, height: 0 }, icon: options.icon, title: options.title },
    type: options.type,
    data: {},
    init: dock => {
      element = dock.element as HTMLElement;
      render(element);
    },
    destroy: () => undefined,
  });

  return () => { if (element?.isConnected) render(element); };
}
