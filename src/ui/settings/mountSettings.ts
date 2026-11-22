import { Dialog } from "siyuan";
import { mount, unmount } from "svelte";
import SettingsRoot from "./SettingsRoot.svelte";
import type { FeatureRegistration } from "../../core/framework/FeatureRegistration.ts";
import type { SettingsManager } from "../../core/store/SettingsManager.ts";
import type { FeatureManager } from "../../core/framework/FeatureManager.ts";

/**
 * @design Svelte controls only view lifetime. It never starts Feature runtime or registers
 * menus. Independent `body--settings` window instances mount only this view and stores.
 */
export function createSettingsWindow(deps: {
  registrations: readonly FeatureRegistration<any>[];
  settings: SettingsManager;
  manager?: FeatureManager;
  t: (key: string, values?: Record<string, string | number>) => string;
}) {
  let current: Dialog | undefined;
  let teardown: (() => void) | undefined;

  function close(): void {
    const dialog = current;
    const cleanup = teardown;
    // @safety Clear ownership BEFORE destroy(): Dialog.destroy() dispatches
    // destroyCallback asynchronously (official dialog/index.ts:165-174), so a stale
    // callback must not be able to reach the next instance's teardown.
    current = undefined;
    teardown = undefined;
    cleanup?.();
    dialog?.destroy();
  }

  function open(): void {
    close();
    let dialog!: Dialog;
    dialog = new Dialog({
      title: "OmniKit",
      content: '<div class="omnikit-settings-host" style="height:100%;min-height:24rem"></div>',
      width: "860px",
      height: "600px",
      destroyCallback: () => {
        // @invariant Only the dialog that still owns `current` may run its teardown.
        if (current !== dialog) return;
        current = undefined;
        const cleanup = teardown;
        teardown = undefined;
        cleanup?.();
      },
    });
    try {
      const target = dialog.element.querySelector<HTMLElement>(".omnikit-settings-host");
      if (!target) throw new Error("OmniKit settings mount element missing");
      const instance = mount(SettingsRoot, { target, props: deps });
      teardown = () => { void unmount(instance); };
      current = dialog;
    } catch (error) {
      // Never leave a half-built dialog behind when the view cannot mount.
      dialog.destroy();
      throw error;
    }
  }
  return { open, close };
}
