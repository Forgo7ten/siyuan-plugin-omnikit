import { button, el } from "../common/dom.ts";

export interface DockStatus {
  id: string;
  title: string;
  status: string;
}

export interface DockViewOptions {
  title: string;
  statuses: () => DockStatus[];
  t: (key: string, values?: Record<string, string | number>) => string;
  openSettings: () => void;
}

/**
 * @design The desktop Dock reports runtime state and links to settings. Business actions
 * stay in menus owned by their feature; the Dock is not a second settings page.
 * @invariant Disabled features keep a visible row so they can be re-enabled.
 */
export function renderDesktopDock(element: HTMLElement, options: DockViewOptions): void {
  element.classList.add("omnikit-dock");
  element.replaceChildren();
  element.append(el("h2", "omnikit-heading", options.title));
  element.append(el("p", undefined, options.t("dock.note")));

  for (const status of options.statuses()) {
    const row = el("div", "omnikit-dock-row");
    row.append(el("strong", undefined, status.title));
    const off = status.status !== "enabled";
    row.append(el("span", off ? "omnikit-state omnikit-state--off" : "omnikit-state",
      options.t("status", { status: status.status })));
    element.append(row);
  }

  element.append(button(options.t("dock.openSettings"), options.openSettings));
}
