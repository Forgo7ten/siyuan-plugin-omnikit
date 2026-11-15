import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { stripTypeScriptTypes } from "node:module";

const read = path => readFile(new URL(path, import.meta.url), "utf8");

test("topbar options and menu registration define only settings item and native separator without dock action", async () => {
  const topbar = await read("../../src/ui/topbar/registerTopBar.ts");
  const plugin = await read("../../src/core/OmniKitPlugin.ts");
  const zh = JSON.parse(await read("../../src/i18n/zh-CN.json"));
  const en = JSON.parse(await read("../../src/i18n/en.json"));

  // Settings item and native separator are present in both open() and contextMenu()
  assert.match(topbar, /id:\s*"omnikit-open-settings"/);
  assert.match(topbar, /menu\.addSeparator\(\{\s*id:\s*"separator_settings"\s*\}\)/);
  assert.match(topbar, /menu\.addSeparator\(undefined,\s*"separator_settings"\)/);

  // Dock action, helpers, and constants are completely removed
  assert.doesNotMatch(topbar, /DOCK_NAME/);
  assert.doesNotMatch(topbar, /openOmniKitDock/);
  assert.doesNotMatch(topbar, /omnikit-open-dock/);
  assert.doesNotMatch(topbar, /menu\.openDock/);
  assert.doesNotMatch(topbar, /iconDock/);
  assert.doesNotMatch(topbar, /openDock/);

  // OmniKitPlugin has openDock removed
  assert.doesNotMatch(plugin, /openOmniKitDock/);
  assert.doesNotMatch(plugin, /openDock\(/);
  assert.doesNotMatch(plugin, /openDock:/);

  // i18n keys for menu.openDock removed, dock.heroTitle/heroSubtitle retained
  assert.equal(zh["menu.openDock"], undefined);
  assert.equal(en["menu.openDock"], undefined);
  assert.equal(zh["dock.heroTitle"], "OmniKit / 图片记录");
  assert.equal(zh["dock.heroSubtitle"], "图片资产管理与无损追溯");
  assert.equal(en["dock.heroTitle"], "OmniKit / Image Records");
  assert.equal(en["dock.heroSubtitle"], "Asset Management & Traceability");
});

test("registerTopBar runtime creates settings item and native separator in menu callbacks", async () => {
  const source = await read("../../src/ui/topbar/registerTopBar.ts");
  const mockSiyuan = `
    class Menu {
      constructor(id) { this.id = id; this.items = []; this.separators = []; }
      addItem(item) { this.items.push(item); return this; }
      addSeparator(options) { this.separators.push(options); return this; }
      open() {}
      fullscreen() {}
    }
    const getActiveEditor = () => ({ protyle: { block: { rootID: "root-123" } } });
    const getFrontend = () => "desktop";
  `;
  const runnable = stripTypeScriptTypes(
    source
      .replace(/import\s*\{[^}]*\}\s*from\s*"siyuan";/, mockSiyuan)
      .replace(/import type \{ MenuRegistry \} from "\.\.\/\.\.\/core\/MenuRegistry\.ts";/, "")
  );
  const { registerTopBar } = await import(`data:text/javascript,${encodeURIComponent(runnable)}`);

  let topBarDef;
  const mockPlugin = {
    addTopBar: def => {
      topBarDef = def;
      return { getBoundingClientRect: () => ({ right: 100, bottom: 30, width: 24 }) };
    },
  };

  const menuCalls = [];
  const mockMenus = {
    render: (location, menu, context) => {
      menuCalls.push({ location, context });
    },
  };

  let settingsOpened = false;
  registerTopBar(mockPlugin, {
    title: "OmniKit 设置",
    menus: mockMenus,
    openSettings: () => { settingsOpened = true; },
  });

  assert.equal(topBarDef.id, "omnikit-core");
  assert.equal(topBarDef.icon, "iconOmnikitMenu");
  assert.equal(topBarDef.title, "OmniKit");

  // Verify contextMenu
  const contextMenuItems = [];
  const contextMenuSeparators = [];
  const mockContextMenu = {
    addItem: item => contextMenuItems.push(item),
    addSeparator: (index, id) => contextMenuSeparators.push({ index, id }),
  };

  topBarDef.contextMenu(mockContextMenu);

  // Assert contextMenu contains only settings and native separator, no dock
  assert.equal(contextMenuItems.length, 1);
  assert.equal(contextMenuItems[0].id, "omnikit-open-settings");
  assert.equal(contextMenuItems[0].label, "OmniKit 设置");
  assert.equal(contextMenuItems[0].icon, "iconSettings");
  assert.equal(contextMenuSeparators.length, 1);
  assert.equal(contextMenuSeparators[0].id, "separator_settings");

  contextMenuItems[0].click();
  assert.equal(settingsOpened, true);
  assert.equal(menuCalls.length, 1);
  assert.equal(menuCalls[0].location, "topbar");
  assert.equal(menuCalls[0].context.rootID, "root-123");
});
