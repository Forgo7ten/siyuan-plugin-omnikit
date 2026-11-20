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
const platformUrl = new URL("../../../src/core/host/Platform.ts", import.meta.url).href;
const protyleAdapterUrl = new URL("../../../src/core/host/ProtyleAdapter.ts", import.meta.url).href;
const domUrl = new URL("../../../src/core/host/dom.ts", import.meta.url).href;

const runnable = stripTypeScriptTypes(source
  .replace(/import\s*\{[^}]*\}\s*from\s*"siyuan";/, 'const getFrontend = () => "desktop"; const showMessage = () => {};')
  .replace(/import\s*\{\s*KernelClient\s*\}\s*from\s*["'][^"']+["'];?/, 'class KernelClient { post() { return Promise.resolve({ data: {} }); } }')
  .replace(/from\s*["'][^"']*BaseFeature\.ts["']/, `from "${baseFeatureUrl}"`)
  .replace(/from\s*["'][^"']*Platform\.ts["']/, `from "${platformUrl}"`)
  .replace(/from\s*["'][^"']*ProtyleAdapter\.ts["']/, `from "${protyleAdapterUrl}"`)
  .replace(/from\s*["'][^"']*dom\.ts["']/, `from "${domUrl}"`)
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

function createEditorHost() {
  const events = new Map();
  const menuContributions = [];
  const notices = [];
  const mockPlugin = {
    i18n: {
      "feature.titledLink.title": "自动标题链接",
      "feature.titledLink.description": "自动提取标题",
      "titledLink.menuSingle": "提取链接标题",
      "titledLink.menuBatch": "批量提取链接标题 (共 {count} 个)",
      "titledLink.failed": "提取失败",
    },
    eventBus: {
      on(name, handler) {
        if (!events.has(name)) events.set(name, new Set());
        events.get(name).add(handler);
      },
      off(name, handler) {
        events.get(name)?.delete(handler);
      },
      emit(name, detail) {
        for (const handler of events.get(name) ?? []) handler({ detail });
      },
    },
  };
  const mockSettings = {
    store() { return {}; },
    getFeature() { return { auto: { enabled: true }, replaceTitle: false, maxTitleLength: 80, fallbackToHostname: true }; },
    getUserAgent() { return "Mozilla/5.0"; },
  };
  const mockContext = {
    plugin: mockPlugin,
    settings: mockSettings,
    logger: { info() {}, warn() {}, error() {}, debug() {} },
    feedback: {
      forScope() { return this; },
      notify(msg, type, opts) { notices.push({ msg, type, opts }); },
    },
    menus: {
      contribute(_scope, featureId, location, id, handler) {
        menuContributions.push({ featureId, location, id, handler });
      },
    },
  };
  return { events, menuContributions, notices, mockPlugin, mockSettings, mockContext };
}

function createFakeHTMLElement() {
  const listeners = [];
  const removed = [];
  const el = Object.create(HTMLElement.prototype);
  el.isConnected = true;
  el.tagName = "DIV";
  el.addEventListener = (type, fn, opts) => listeners.push({ type, fn, opts });
  el.removeEventListener = (type, fn, opts) => removed.push({ type, fn, opts });
  el.dispatchCapture = (type) => {
    // Simulate SiYuan's wysiwyg bubble stopPropagation: only capture listeners on .protyle receive the event.
    for (const entry of listeners) {
      if (entry.type === type && entry.opts?.capture === true) {
        entry.fn({ currentTarget: el });
      }
    }
  };
  return { el, listeners, removed };
}

test("IME tracking registers capture-phase listeners, isolates split-pane editors, ignores detached editors, and expires stale composition", async () => {
  let currentNow = 1_000;
  const { mockPlugin, mockSettings, mockContext } = createEditorHost();
  const feature = new TitledLinkFeature(mockPlugin, mockSettings, { now: () => currentNow });
  await feature.activate(mockContext);

  const editorA = createFakeHTMLElement();
  const editorB = createFakeHTMLElement();
  mockPlugin.eventBus.emit("loaded-protyle-static", { protyle: { element: editorA.el } });
  mockPlugin.eventBus.emit("switch-protyle", { protyle: { element: editorB.el } });

  assert.equal(editorA.listeners.length, 2);
  assert.deepEqual(editorA.listeners.map(l => [l.type, l.opts]), [
    ["compositionstart", { capture: true }],
    ["compositionend", { capture: true }],
  ]);

  const isComposing = feature.controller.options.isComposing;

  // Editor A starts composing; Editor B is NOT blocked (split-pane isolation)
  editorA.el.dispatchCapture("compositionstart");
  assert.equal(isComposing({ element: editorA.el }), true);
  assert.equal(isComposing({ element: editorB.el }), false);

  // If editor A leaves the document without compositionend, it no longer blocks
  editorA.el.isConnected = false;
  assert.equal(isComposing({ element: editorA.el }), false);
  editorA.el.isConnected = true;

  // After >10s without compositionend, stale composition expires automatically
  currentNow += 10_001;
  assert.equal(isComposing({ element: editorA.el }), false);

  // Fresh compositionstart then compositionend resets state cleanly
  editorA.el.dispatchCapture("compositionstart");
  assert.equal(isComposing({ element: editorA.el }), true);
  editorA.el.dispatchCapture("compositionend");
  assert.equal(isComposing({ element: editorA.el }), false);

  // destroy-protyle removes listeners with { capture: true } and clears map entry
  mockPlugin.eventBus.emit("destroy-protyle", { protyle: { element: editorA.el } });
  assert.deepEqual(editorA.removed.map(l => [l.type, l.opts]), [
    ["compositionstart", { capture: true }],
    ["compositionend", { capture: true }],
  ]);

  await feature.deactivate();
  assert.deepEqual(editorB.removed.map(l => [l.type, l.opts]), [
    ["compositionstart", { capture: true }],
    ["compositionend", { capture: true }],
  ]);
});

test("clears controller cache when settings change and routes notifications through context.feedback", async () => {
  const { mockPlugin, mockSettings, mockContext, notices, menuContributions } = createEditorHost();
  const feature = new TitledLinkFeature(mockPlugin, mockSettings);
  await feature.activate(mockContext);

  const cache = feature.controller.cache;
  const gen = cache.captureGeneration("https://example.com/");
  cache.set("https://example.com/", "Cached", gen);
  assert.equal(cache.size, 1);

  await feature.notifySettingsChanged();
  assert.equal(cache.size, 0);

  // Trigger manual failure to verify context.feedback.notify is invoked instead of direct showMessage
  const linkMenu = menuContributions.find(m => m.location === "link");
  const link = {
    getAttribute: attr => (attr === "data-type" ? "a" : attr === "data-href" ? "https://example.com" : null),
    textContent: "https://example.com",
    closest: () => null,
  };
  const items = linkMenu.handler({ detail: { element: link, protyle: { element: {} } } });
  await items[0].run();
  assert.equal(notices.length, 1);
  assert.equal(notices[0].msg, "提取失败");

  await feature.deactivate();
});

test("TitledLinkSettingsPanel uses Core describeError, isSettingsConflictError, and theme CSS variables", async () => {
  const svelte = await read("../../../src/features/titled-link/ui/TitledLinkSettingsPanel.svelte");
  assert.match(svelte, /describeError/);
  assert.match(svelte, /SettingsConflictError/);
  assert.match(svelte, /isSettingsConflictError/);
  assert.doesNotMatch(svelte, /includes\(t\("settings\.concurrentChange"\)\)/);
  assert.match(svelte, /var\(--b3-theme-on-surface-light\)/);
  assert.match(svelte, /var\(--b3-theme-error\)/);
});
