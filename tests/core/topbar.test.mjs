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

test("registerTopBar runtime creates settings item, removes dangling separator on 0 items, and routes desktop/mobile open", async () => {
  const source = await read("../../src/ui/topbar/registerTopBar.ts");
  const platformUrl = new URL("../../src/core/host/Platform.ts", import.meta.url).href;
  const { setFrontendResolver } = await import(platformUrl);
  const createdMenus = [];
  globalThis.__omnikitTestTopBarMenus = createdMenus;
  const mockSiyuan = `
    class Menu {
      constructor(id) {
        this.id = id;
        this.items = [];
        this.separators = [];
        this.openCalls = [];
        this.fullscreenCalls = 0;
        globalThis.__omnikitTestTopBarMenus.push(this);
      }
      addItem(item) { this.items.push(item); return this; }
      addSeparator(options) {
        const sep = { options, removed: false, remove() { this.removed = true; } };
        this.separators.push(sep);
        return sep;
      }
      open(opts) { this.openCalls.push(opts); }
      fullscreen() { this.fullscreenCalls += 1; }
    }
    const getActiveEditor = () => ({ protyle: { block: { rootID: "root-123" } } });
  `;
  const runnable = stripTypeScriptTypes(
    source
      .replace(/import\s*\{[^}]*\}\s*from\s*"siyuan";/, mockSiyuan)
      .replace(/import\s+type\s*\{[^}]*\}\s*from\s*"\.\.\/\.\.\/core\/feedback\/MenuRegistry\.ts";/, "")
      .replace(/from\s*"\.\.\/\.\.\/core\/host\/Platform\.ts"/, `from "${platformUrl}"`),
  );
  const { registerTopBar } = await import(`data:text/javascript,${encodeURIComponent(runnable)}`);

  const prevDoc = globalThis.document;
  const prevWin = globalThis.window;
  globalThis.document = { querySelector: () => null };
  globalThis.window = { innerWidth: 1280 };

  try {
    let topBarDef;
    const mockPlugin = {
      addTopBar: def => {
        topBarDef = def;
        return { getBoundingClientRect: () => ({ right: 100, bottom: 30, width: 24 }) };
      },
    };

    let renderReturnCount = 0;
    const menuCalls = [];
    const mockMenus = {
      render: (location, menu, context) => {
        menuCalls.push({ location, context });
        return renderReturnCount;
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

    // 1. Left-click with 0 feature items removes dangling separator and opens desktop menu
    setFrontendResolver(() => "desktop");
    renderReturnCount = 0;
    topBarDef.callback();
    assert.equal(createdMenus.length, 1);
    assert.equal(createdMenus[0].items.length, 1);
    assert.equal(createdMenus[0].separators.length, 1);
    assert.equal(createdMenus[0].separators[0].removed, true, "dangling separator must be removed when 0 feature items render");
    assert.equal(createdMenus[0].openCalls.length, 1);
    assert.equal(createdMenus[0].fullscreenCalls, 0);

    // 2. Left-click with >0 feature items keeps separator and uses fullscreen on mobile
    setFrontendResolver(() => "mobile");
    renderReturnCount = 2;
    topBarDef.callback();
    assert.equal(createdMenus.length, 2);
    assert.equal(createdMenus[1].separators[0].removed, false, "separator must be kept when feature items render");
    assert.equal(createdMenus[1].fullscreenCalls, 1);
    assert.equal(createdMenus[1].openCalls.length, 0);

    // 3. Verify contextMenu
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
    assert.equal(menuCalls.at(-1).location, "topbar");
    assert.equal(menuCalls.at(-1).context.rootID, "root-123");
  } finally {
    setFrontendResolver(undefined);
    delete globalThis.__omnikitTestTopBarMenus;
    globalThis.document = prevDoc;
    globalThis.window = prevWin;
  }
});


test("registerTopBar resolves active main document tab via getAllModels().editor when focus is in sidebar or backlink", async () => {
  const source = await read("../../src/ui/topbar/registerTopBar.ts");
  const platformUrl = new URL("../../src/core/host/Platform.ts", import.meta.url).href;
  const { setFrontendResolver } = await import(platformUrl);
  const backlinkEditor = { protyle: { block: { rootID: "backlink-sub-editor" } } };
  const docOldEditor = {
    protyle: {
      block: { rootID: "doc-older" },
      element: { classList: { contains: () => false } },
      model: { headElement: { classList: { contains: c => c === "item--focus" }, dataset: { activetime: "100" } } },
    },
  };
  const docRecentEditor = {
    protyle: {
      block: { rootID: "doc-recent" },
      element: { classList: { contains: () => false } },
      model: { headElement: { classList: { contains: c => c === "item--focus" }, dataset: { activetime: "250" } } },
    },
  };
  globalThis.__omnikitTopBarGetActive = () => backlinkEditor;
  globalThis.__omnikitTopBarGetModels = () => ({
    editor: [{ editor: docOldEditor }, { editor: docRecentEditor }],
  });
  const mockSiyuan = `
    class Menu {
      addItem() { return this; }
      addSeparator() { return { remove() {} }; }
      open() {}
      fullscreen() {}
    }
    const getActiveEditor = () => globalThis.__omnikitTopBarGetActive();
    const getAllModels = () => globalThis.__omnikitTopBarGetModels();
  `;
  const runnable = stripTypeScriptTypes(
    source
      .replace(/import\s*\{[^}]*\}\s*from\s*"siyuan";/, mockSiyuan)
      .replace(/import\s+type\s*\{[^}]*\}\s*from\s*"\.\.\/\.\.\/core\/feedback\/MenuRegistry\.ts";/, "")
      .replace(/from\s*"\.\.\/\.\.\/core\/host\/Platform\.ts"/, `from "${platformUrl}"`),
  );
  const { registerTopBar } = await import(`data:text/javascript,${encodeURIComponent(runnable)}`);

  const prevDoc = globalThis.document;
  const prevWin = globalThis.window;
  globalThis.document = { querySelector: () => null };
  globalThis.window = { innerWidth: 1280 };
  try {
    setFrontendResolver(() => "desktop");
    let topBarDef;
    const contexts = [];
    registerTopBar(
      { addTopBar: def => { topBarDef = def; return { getBoundingClientRect: () => ({ right: 80, bottom: 28, width: 24 }) }; } },
      {
        title: "OmniKit 设置",
        menus: { render: (_loc, _menu, ctx) => { contexts.push(ctx); return 1; } },
        openSettings: () => {},
      },
    );
    topBarDef.callback();
    assert.equal(contexts[0].rootID, "doc-recent");
    assert.equal(contexts[0].protyle, docRecentEditor.protyle);
  } finally {
    setFrontendResolver(undefined);
    delete globalThis.__omnikitTopBarGetActive;
    delete globalThis.__omnikitTopBarGetModels;
    globalThis.document = prevDoc;
    globalThis.window = prevWin;
  }
});
