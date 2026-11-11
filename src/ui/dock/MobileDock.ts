import { button, el } from "../common/dom.ts";
import type { DockViewOptions } from "./DesktopDock.ts";

/**
 * @design Mobile keeps a compact summary: counting running features is enough at a glance,
 * while per-feature detail remains in settings.
 */
export function renderMobileDock(element: HTMLElement, options: DockViewOptions): void {
  element.classList.add("omnikit-dock");
  element.replaceChildren();
  const statuses = options.statuses();
  const running = statuses.filter(status => status.status === "enabled").length;

  element.append(el("h2", "omnikit-heading", options.title));
  element.append(el("p", "omnikit-state", options.t("dock.summary", { running, total: statuses.length })));
  element.append(button(options.t("dock.openSettings"), options.openSettings));
}
