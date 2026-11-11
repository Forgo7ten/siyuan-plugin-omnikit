import { Dialog } from "siyuan";
import { mount, unmount } from "svelte";
import SettingsRoot from "./SettingsRoot.svelte";
import type { FeatureRegistration } from "../../core/FeatureRegistration.ts";
import type { SettingsManager } from "../../core/SettingsManager.ts";
import type { FeatureManager } from "../../core/FeatureManager.ts";

/**
 * @design Svelte controls only view lifetime. It never starts Feature runtime or registers
 * menus. Future SiYuan 3.8.7+ settings-window instances mount only this view and stores.
 */
export function createSettingsWindow(deps: {
  registrations: readonly FeatureRegistration<any>[];
  settings: SettingsManager;
  manager?: FeatureManager;
  t: (key: string) => string;
}) {
  let current: Dialog | undefined;
  let teardown: (() => void) | undefined;
  function close(): void {
    const cleanup = teardown;
    teardown = undefined;
    cleanup?.();
    current?.destroy();
    current = undefined;
  }
  function open(): void {
    close();
    const dialog = new Dialog({
      title: "OmniKit",
      content: '<div class="omnikit-settings-host" style="height:100%;min-height:24rem"></div>',
      width: "860px",
      height: "600px",
      destroyCallback: () => {
        if (teardown) { const fn = teardown; teardown = undefined; fn(); }
        if (current === dialog) current = undefined;
      },
    });
    const target = dialog.element.querySelector<HTMLElement>(".omnikit-settings-host");
    if (!target) throw new Error("OmniKit settings mount element missing");
    const instance = mount(SettingsRoot, { target, props: deps });
    teardown = () => { void unmount(instance); };
    current = dialog;
  }
  return { open, close };
}
