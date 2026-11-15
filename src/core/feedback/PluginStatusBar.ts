import type { Plugin } from "siyuan";
import { isMobileFrontend } from "../host/Platform.ts";

/**
 * Universal singleton status bar manager for OmniKit.
 * Mounted only on supported desktop frontends in SiYuan's main layout.
 * Class name is standardized as `.omnikit-status-bar` (never hardcodes feature names).
 */
export class PluginStatusBar {
  private element?: HTMLElement;
  private readonly tasks = new Map<string, string>();
  private mounted = false;

  mount(plugin: Plugin): void {
    if (this.mounted) return;
    if (isMobileFrontend()) return;
    if (typeof document !== "undefined" && document.body.classList.contains("body--settings")) return;
    if (typeof document === "undefined") return;

    this.element = document.createElement("div");
    this.element.className = "toolbar__item omnikit-status-bar fn__none";
    this.element.setAttribute("role", "status");
    this.element.setAttribute("aria-live", "polite");

    const result = plugin.addStatusBar({
      element: this.element,
      position: "left",
    });

    this.mounted = result === this.element;
    if (!this.mounted) {
      this.element.remove();
      this.element = undefined;
    }
  }

  update(taskID: string, text: string): void {
    if (!this.mounted || !this.element) return;
    this.tasks.set(taskID, text);
    this.render();
  }

  clear(taskID: string): void {
    if (!this.mounted || !this.element) return;
    this.tasks.delete(taskID);
    this.render();
  }

  dispose(): void {
    this.tasks.clear();
    this.element?.remove();
    this.element = undefined;
    this.mounted = false;
  }

  isMounted(): boolean {
    return this.mounted;
  }

  private render(): void {
    if (!this.element) return;
    const latest = [...this.tasks.values()].at(-1);
    if (!latest) {
      this.element.classList.add("fn__none");
      this.element.textContent = "";
      this.element.removeAttribute("title");
      return;
    }
    this.element.textContent = latest;
    this.element.title = latest;
    this.element.classList.remove("fn__none");
  }
}
