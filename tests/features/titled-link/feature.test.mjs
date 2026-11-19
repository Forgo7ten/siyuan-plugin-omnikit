import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { stripTypeScriptTypes } from "node:module";

const read = path => readFile(new URL(path, import.meta.url), "utf8");

if (typeof globalThis.HTMLElement === "undefined") {
  globalThis.HTMLElement = class HTMLElement {};
}

const fileUrl = new URL("../../../src/features/titled-link/TitledLinkFeature.ts", import.meta.url);
const source = await readFile(fileUrl, "utf8");
const baseFeatureUrl = new URL("../../../src/core/framework/BaseFeature.ts", import.meta.url).href;
const translateUrl = new URL("../../../src/i18n/translate.ts", import.meta.url).href;
const controllerUrl = new URL("../../../src/features/titled-link/TitledLinkController.ts", import.meta.url).href;

const runnable = stripTypeScriptTypes(source
  .replace(/import\s*\{\s*getFrontend,\s*showMessage\s*\}\s*from\s*"siyuan";/, 'const getFrontend = () => "desktop"; const showMessage = () => {};')
  .replace(/import\s*\{\s*KernelClient\s*\}\s*from\s*["'][^"']+["'];?/, 'class KernelClient { post() { return Promise.resolve({ data: {} }); } }')
  .replace(/from\s*["'][^"']*BaseFeature\.ts["']/, `from "${baseFeatureUrl}"`)
  .replace(/from\s*["'][^"']*translate\.ts["']/, `from "${translateUrl}"`)
  .replace(/from\s*["'][^"']*TitledLinkController\.ts["']/g, `from "${controllerUrl}"`)
);

const { TitledLinkFeature } = await import(`data:text/javascript,${encodeURIComponent(runnable)}`);

test("feature lifecycle activates event listeners, contributes menus, and disposes cleanly", async () => {
  const events = new Map();
  const mockPlugin = {
    i18n: {
      "feature.titledLink.title": "自动标题链接",
      "feature.titledLink.description": "自动提取标题",
      "titledLink.menuSingle": "提取链接标题",
      "titledLink.menuBatch": "批量提取链接标题 (共 {count} 个)",
    },
    eventBus: {
      on(name, handler) {
        if (!events.has(name)) events.set(name, new Set());
        events.get(name).add(handler);
      },
      off(name, handler) {
        events.get(name)?.delete(handler);
      },
    },
  };

  const storedFeatures = [];
  const mockSettings = {
    store(id) { storedFeatures.push(id); return {}; },
    getFeature() { return { auto: { enabled: true }, replaceTitle: false }; },
    getUserAgent() { return "Mozilla/5.0"; },
  };

  const menuContributions = [];
  const mockContext = {
    plugin: mockPlugin,
    settings: mockSettings,
    logger: { info() {}, warn() {}, error() {}, debug() {} },
    menus: {
      contribute(scope, featureId, location, id, handler) {
        menuContributions.push({ featureId, location, id, handler });
      },
    },
  };

  const feature = new TitledLinkFeature(mockPlugin, mockSettings);
  assert.equal(storedFeatures.includes("titled-link"), true);
  assert.equal(feature.meta.id, "titled-link");

  await feature.activate(mockContext);
  assert.equal(feature.status, "enabled");

  // Verify event listeners were registered
  assert.equal(events.get("paste")?.size, 1);
  assert.equal(events.get("loaded-protyle-static")?.size, 1);
  assert.equal(events.get("switch-protyle")?.size, 1);
  assert.equal(events.get("destroy-protyle")?.size, 1);

  // Verify menu contributions
  const linkMenu = menuContributions.find(m => m.location === "link");
  const blockMenu = menuContributions.find(m => m.location === "blockicon");
  assert.ok(linkMenu, "Link menu must be contributed");
  assert.ok(blockMenu, "Block menu must be contributed");

  // Test link menu callback returns item for HTTP/HTTPS and skips non-HTTP(S) schemes
  const makeLink = href => ({
    getAttribute(attr) { return attr === "data-type" ? "a" : attr === "data-href" ? href : null; },
    textContent: href,
  });
  const mockProtyle = { element: { addEventListener() {}, removeEventListener() {} } };
  const singleHttps = linkMenu.handler({ detail: { element: makeLink("https://example.com"), protyle: mockProtyle } });
  assert.equal(singleHttps.length, 1);
  assert.equal(singleHttps[0].id, "extract-link-title");
  assert.equal(linkMenu.handler({ detail: { element: makeLink("http://example.com"), protyle: mockProtyle } }).length, 1);
  assert.deepEqual(linkMenu.handler({ detail: { element: makeLink("mailto:user@example.com"), protyle: mockProtyle } }), []);
  assert.deepEqual(linkMenu.handler({ detail: { element: makeLink("siyuan://blocks/20260101000000-abcdefg"), protyle: mockProtyle } }), []);
  assert.deepEqual(linkMenu.handler({ detail: { element: makeLink("javascript:alert(1)"), protyle: mockProtyle } }), []);
  assert.deepEqual(linkMenu.handler({ detail: { element: makeLink(""), protyle: mockProtyle } }), []);

  // Deactivate feature and verify cleanup
  await feature.deactivate();
  assert.equal(feature.status, "disabled");
  assert.equal(events.get("paste")?.size, 0);
  assert.equal(events.get("loaded-protyle-static")?.size, 0);
  assert.equal(events.get("switch-protyle")?.size, 0);
  assert.equal(events.get("destroy-protyle")?.size, 0);
});

test("feature registration and both locales include titled-link settings", async () => {
  const [plugin, registration, zh, en] = await Promise.all([
    read("../../../src/core/OmniKitPlugin.ts"),
    read("../../../src/features/titled-link/registration.ts"),
    read("../../../src/i18n/zh-CN.json"),
    read("../../../src/i18n/en.json"),
  ]);
  assert.match(plugin, /registrations = \[imageCompressorRegistration, titledLinkRegistration\]/);
  assert.match(registration, /id: "titled-link"/);
  assert.match(registration, /settingsView: TitledLinkSettingsPanel/);
  for (const key of ["feature.titledLink.title", "titledLink.menuSingle", "titledLink.menuBatch", "titledLink.updated"]) {
    assert.ok(zh.includes(`"${key}"`), `Chinese locale is missing ${key}`);
    assert.ok(en.includes(`"${key}"`), `English locale is missing ${key}`);
  }
});
