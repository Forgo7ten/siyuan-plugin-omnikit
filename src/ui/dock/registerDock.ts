import type { Component } from "svelte";
import { mount, unmount } from "svelte";
import type { Plugin } from "siyuan";
import type { FeatureContext } from "../../core/framework/FeatureContext.ts";
import { isFrontendSupported, isMobileFrontend, type SiyuanFrontend } from "../../core/host/Platform.ts";
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

export interface DockHandle {
  refresh: () => void;
  dispose: () => void;
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
export function registerDock(plugin: Plugin, options: RegisterDockOptions): DockHandle {
  let element: HTMLElement | undefined;
  let heading: HTMLElement | undefined;
  let tabsHost: HTMLElement | undefined;
  let viewHost: HTMLElement | undefined;
  let emptyHint: HTMLElement | undefined;
  let settingsBtn: HTMLButtonElement | undefined;
  let selectedID: string | undefined;
  let mounted: ReturnType<typeof mount> | undefined;
  let mountedID: string | undefined;
  let mountedComponent: FeatureDockView["component"] | undefined;
  let lastTabsSignature: string | undefined;

  const ensureShell = (): void => {
    if (!element || heading) return;
    element.classList.add("omnikit-dock");
    element.replaceChildren();
    heading = el("h2", "omnikit-heading", options.title);
    tabsHost = el("div", "omnikit-dock-tabs");
    tabsHost.setAttribute("role", "tablist");
    viewHost = el("div", "omnikit-dock-view");
    emptyHint = el("p", "omnikit-dock-empty", options.t("dock.empty"));
    settingsBtn = button(options.t("dock.openSettings"), options.openSettings);
    element.append(heading, tabsHost, viewHost, emptyHint, settingsBtn);
  };

  const cleanup = (): void => {
    if (mounted) {
      void unmount(mounted);
      mounted = undefined;
    }
    mountedID = undefined;
    mountedComponent = undefined;
    lastTabsSignature = undefined;
    element?.replaceChildren?.();
    heading = undefined;
    tabsHost = undefined;
    viewHost = undefined;
    emptyHint = undefined;
    settingsBtn = undefined;
    element = undefined;
  };

  const render = (): void => {
    if (!element) return;
    ensureShell();
    if (!heading || !tabsHost || !viewHost || !emptyHint || !settingsBtn) return;

    heading.textContent = options.title;
    settingsBtn.textContent = options.t("dock.openSettings");

    const views = filterSupportedDockViews(options.views());
    const state = dockViewState(views, selectedID);
    selectedID = state.selected?.id;

    if (state.showTabs) {
      const tabsSignature = JSON.stringify({
        selectedID,
        views: views.map(view => ({ id: view.id, title: view.title })),
      });
      if (tabsSignature !== lastTabsSignature) {
        const tabs: HTMLButtonElement[] = [];
        for (const view of views) {
          const tab = button(view.title, () => {
            selectedID = view.id;
            render();
          });
          tab.setAttribute("role", "tab");
          tab.setAttribute("aria-selected", String(view.id === selectedID));
          tabs.push(tab);
        }
        tabsHost.replaceChildren(...tabs);
        lastTabsSignature = tabsSignature;
      }
      tabsHost.style.display = "";
    } else {
      if (lastTabsSignature !== "") {
        tabsHost.replaceChildren();
        lastTabsSignature = "";
      }
      tabsHost.style.display = "none";
    }

    const selected = state.selected;
    if (selected && mounted && mountedID === selected.id && mountedComponent === selected.component) {
      viewHost.style.display = "";
      emptyHint.style.display = "none";
      return;
    }

    if (mounted) {
      void unmount(mounted);
      mounted = undefined;
    }
    mountedID = undefined;
    mountedComponent = undefined;
    viewHost.replaceChildren();

    if (selected) {
      viewHost.style.display = "";
      emptyHint.style.display = "none";
      mounted = mount(selected.component, {
        target: viewHost,
        props: { context: options.context, t: options.t },
      });
      mountedID = selected.id;
      mountedComponent = selected.component;
    } else {
      viewHost.style.display = "none";
      emptyHint.textContent = options.t("dock.empty");
      emptyHint.style.display = "";
    }
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
    destroy: cleanup,
  });

  return {
    refresh: render,
    dispose: () => {
      cleanup();
      if (isMobileFrontend()) {
        (plugin as Plugin & { removeDock?: (type: string) => void }).removeDock?.(options.type);
      }
    },
  };
}
