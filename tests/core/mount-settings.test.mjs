import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { stripTypeScriptTypes } from "node:module";

const source = await readFile(new URL("../../src/ui/settings/mountSettings.ts", import.meta.url), "utf8");

function loadMountSettings() {
  const dialogs = [];
  const mounted = [];
  const unmounted = [];
  let seq = 0;

  class MockDialog {
    constructor(options) {
      this.id = ++seq;
      this.options = options;
      this.destroyed = false;
      this.element = {
        querySelector: selector => (selector === ".omnikit-settings-host" ? { selector } : null),
      };
      dialogs.push(this);
    }
    destroy() {
      this.destroyed = true;
      setTimeout(() => {
        this.options.destroyCallback?.();
      }, 0);
    }
  }

  function mockMount(_component, { target, props }) {
    const instance = { id: ++seq, target, props };
    mounted.push(instance);
    return instance;
  }

  function mockUnmount(instance) {
    unmounted.push(instance);
  }

  const transformed = stripTypeScriptTypes(
    source
      .replace('import { Dialog } from "siyuan";', "const { Dialog, mount, unmount, SettingsRoot } = globalThis.__mountSettingsDeps;")
      .replace('import { mount, unmount } from "svelte";', "")
      .replace('import SettingsRoot from "./SettingsRoot.svelte";', "")
      .replace(/import type .*?;\n/g, ""),
  );

  return { dialogs, mounted, unmounted, MockDialog, mockMount, mockUnmount, transformed };
}

test("createSettingsWindow ignores stale async destroyCallback from a replaced dialog", async () => {
  const env = loadMountSettings();
  globalThis.__mountSettingsDeps = {
    Dialog: env.MockDialog,
    mount: env.mockMount,
    unmount: env.mockUnmount,
    SettingsRoot: {},
  };

  try {
    const { createSettingsWindow } = await import(`data:text/javascript,${encodeURIComponent(env.transformed)}`);
    const win = createSettingsWindow({
      registrations: [],
      settings: {},
      t: key => key,
    });

    win.open();
    assert.equal(env.mounted.length, 1);
    assert.equal(env.unmounted.length, 0);

    // Reopen before the first dialog's async destroyCallback fires
    win.open();
    assert.equal(env.mounted.length, 2);
    assert.equal(env.unmounted.length, 1);
    assert.strictEqual(env.unmounted[0], env.mounted[0]);

    // Flush first dialog's async destroyCallback
    await new Promise(resolve => setTimeout(resolve, 20));
    assert.equal(env.unmounted.length, 1, "stale destroyCallback must not unmount the newly opened instance");

    win.close();
    assert.equal(env.unmounted.length, 2);
    assert.strictEqual(env.unmounted[1], env.mounted[1]);
  } finally {
    delete globalThis.__mountSettingsDeps;
  }
});
