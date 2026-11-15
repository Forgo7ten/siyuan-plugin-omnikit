import type { Component } from "svelte";
import { mount, unmount } from "svelte";
import type { Plugin } from "siyuan";
import type { FeatureContext } from "../../core/FeatureContext.ts";
import { isFrontendSupported, type SiyuanFrontend } from "../../core/Platform.ts";
import { button, el } from "../common/dom.ts";

export interface FeatureDockView {
  id: string;
  title: string;
  component: Component<{ context: FeatureContext; t: (key: string, values?: Record<string, string | number>) => string }>;
  frontends?: readonly SiyuanFrontend[];
}

export interface RegisterDockOptions {
  type: string;
  icon: string;
  title: string;
  context: FeatureContext;
  views: () => FeatureDockView[];
  t: (key: string, values?: Record<string, string | number>) => string;
  openSettings: () => void;
}

export function filterSupportedDockViews<T extends { frontends?: readonly SiyuanFrontend[] }>(
  views: readonly T[],
  currentFrontend?: string,
): T[] {
  return views.filter(view => isFrontendSupported(view.frontends, currentFrontend));
}

/** Stable selection across enable/disable while keeping one-view and empty states explicit. */
export function dockViewState<T extends { id: string }>(views: readonly T[], selectedID?: string): {
  selected?: T; showTabs: boolean; empty: boolean;
} {
  const selected = views.find(view => view.id === selectedID) ?? views[0];
  return { selected, showTabs: views.length > 1, empty: views.length === 0 };
}

/** A single host Dock switches between feature-owned views. */
export function registerDock(plugin: Plugin, options: RegisterDockOptions): () => void {
  let element: HTMLElement | undefined;
  let selectedID: string | undefined;
  let mounted: ReturnType<typeof mount> | undefined;

  const render = (): void => {
    if (!element) return;
    if (mounted) {
      void unmount(mounted);
      mounted = undefined;
    }
    element.classList.add("omnikit-dock");
    element.replaceChildren();
    element.append(el("h2", "omnikit-heading", options.title));

    const views = filterSupportedDockViews(options.views());
    const state = dockViewState(views, selectedID);
    selectedID = state.selected?.id;
    if (state.showTabs) {
      const tabs = el("div", "omnikit-dock-tabs");
      tabs.setAttribute("role", "tablist");
      for (const view of views) {
        const tab = button(view.title, () => {
          selectedID = view.id;
          render();
        });
        tab.setAttribute("role", "tab");
        tab.setAttribute("aria-selected", String(view.id === selectedID));
        tabs.append(tab);
      }
      element.append(tabs);
    }

    const selected = state.selected;
    if (selected) {
      const target = el("div", "omnikit-dock-view");
      element.append(target);
      mounted = mount(selected.component, {
        target,
        props: { context: options.context, t: options.t },
      });
    } else {
      element.append(el("p", "omnikit-dock-empty", options.t("dock.empty")));
    }
    element.append(button(options.t("dock.openSettings"), options.openSettings));
  };

  plugin.addDock({
    config: { position: "RightBottom", size: { width: 320, height: 0 }, icon: options.icon, title: options.title },
    type: options.type,
    data: {},
    init: dock => {
      element = dock.element as HTMLElement;
      render();
    },
    update: () => {
      window.dispatchEvent(new CustomEvent("omnikit-dock-tab-activated"));
    },
    destroy: () => {
      if (mounted) void unmount(mounted);
      mounted = undefined;
      element = undefined;
    },
  });

  return render;
}
