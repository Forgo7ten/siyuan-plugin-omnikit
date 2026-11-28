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
const pasteLinkCaptureUrl = new URL("../../../src/features/titled-link/services/PasteLinkCapture.ts", import.meta.url).href;
const pasteRangeUrl = new URL("../../../src/features/titled-link/policy/paste-range.ts", import.meta.url).href;
const platformUrl = new URL("../../../src/core/host/Platform.ts", import.meta.url).href;
const protyleAdapterUrl = new URL("../../../src/core/host/ProtyleAdapter.ts", import.meta.url).href;
const domUrl = new URL("../../../src/core/host/dom.ts", import.meta.url).href;

const runnable = stripTypeScriptTypes(source
  .replace(/import\s*\{[^}]*\}\s*from\s*"siyuan";/, 'const getAllEditor = () => globalThis.__omnikitTestGetAllEditor?.() ?? [];')
  .replace(/import\s*\{\s*KernelClient\s*\}\s*from\s*["'][^"']+["'];?/, 'class KernelClient { post() { return Promise.resolve({ data: {} }); } }')
  .replace(/from\s*["'][^"']*BaseFeature\.ts["']/, `from "${baseFeatureUrl}"`)
  .replace(/from\s*["'][^"']*Platform\.ts["']/, `from "${platformUrl}"`)
  .replace(/from\s*["'][^"']*ProtyleAdapter\.ts["']/, `from "${protyleAdapterUrl}"`)
  .replace(/from\s*["'][^"']*dom\.ts["']/, `from "${domUrl}"`)
  .replace(/from\s*["'][^"']*translate\.ts["']/, `from "${translateUrl}"`)
  .replace(/from\s*["'][^"']*paste-range\.ts["']/, `from "${pasteRangeUrl}"`)
  .replace(/from\s*["'][^"']*PasteLinkCapture\.ts["']/, `from "${pasteLinkCaptureUrl}"`)
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
    feedback: { forScope() { return this; }, notify() {} },
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

  // Verify event listeners were registered (uses native capture paste instead of eventBus paste)
  assert.equal(events.get("paste"), undefined);
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
  assert.match(plugin, /registrations = \[[^\]]*\btitledLinkRegistration\b[^\]]*\]/);
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
    getFeature() { return { auto: { enabled: true }, replaceTitle: false, fallbackToHostname: true }; },
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
  el.contains = () => true;
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

test("IME tracking and paste capture register existing editors via getAllEditor, deduplicate, and clean up on destroy/deactivate", async () => {
  let currentNow = 1_000;
  const { mockPlugin, mockSettings, mockContext } = createEditorHost();
  const feature = new TitledLinkFeature(mockPlugin, mockSettings, { now: () => currentNow });

  const existingRoot = createFakeHTMLElement();
  const existingWysiwyg = createFakeHTMLElement();
  const existingProtyle = {
    protyle: {
      element: existingRoot.el,
      wysiwyg: { element: existingWysiwyg.el },
    },
  };

  globalThis.__omnikitTestGetAllEditor = () => [existingProtyle];
  try {
    await feature.activate(mockContext);
  } finally {
    delete globalThis.__omnikitTestGetAllEditor;
  }

  // getAllEditor attached both composition tracking (on .element) and capture paste (on wysiwyg.element)
  assert.deepEqual(existingRoot.listeners.map(l => [l.type, l.opts]), [
    ["compositionstart", { capture: true }],
    ["compositionend", { capture: true }],
  ]);
  assert.deepEqual(existingWysiwyg.listeners.map(l => [l.type, l.opts]), [
    ["paste", { capture: true }],
  ]);

  // Emitting switch-protyle for the same wysiwyg.element must not attach duplicate paste listeners
  mockPlugin.eventBus.emit("switch-protyle", { protyle: existingProtyle.protyle });
  assert.equal(existingWysiwyg.listeners.length, 1);

  const editorA = createFakeHTMLElement();
  const wysiwygA = createFakeHTMLElement();
  const editorB = createFakeHTMLElement();
  const wysiwygB = createFakeHTMLElement();
  mockPlugin.eventBus.emit("loaded-protyle-static", { protyle: { element: editorA.el, wysiwyg: { element: wysiwygA.el } } });
  mockPlugin.eventBus.emit("switch-protyle", { protyle: { element: editorB.el, wysiwyg: { element: wysiwygB.el } } });

  assert.equal(editorA.listeners.length, 2);
  assert.equal(wysiwygA.listeners.length, 1);
  assert.deepEqual(editorA.listeners.map(l => [l.type, l.opts]), [
    ["compositionstart", { capture: true }],
    ["compositionend", { capture: true }],
  ]);

  const isComposing = feature.controller.options.isComposing;

  // Editor A starts composing; Editor B is NOT blocked (split-pane isolation)
  editorA.el.dispatchCapture("compositionstart");
  assert.equal(isComposing({ element: editorA.el }), true);
  assert.equal(isComposing({ element: editorB.el }), false);
  // Missing target protyle element must NOT scan other split-pane editors
  assert.equal(isComposing(undefined), false);
  assert.equal(isComposing({}), false);

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
  mockPlugin.eventBus.emit("destroy-protyle", { protyle: { element: editorA.el, wysiwyg: { element: wysiwygA.el } } });
  assert.deepEqual(editorA.removed.map(l => [l.type, l.opts]), [
    ["compositionstart", { capture: true }],
    ["compositionend", { capture: true }],
  ]);
  assert.deepEqual(wysiwygA.removed.map(l => [l.type, l.opts]), [
    ["paste", { capture: true }],
  ]);

  await feature.deactivate();
  assert.deepEqual(editorB.removed.map(l => [l.type, l.opts]), [
    ["compositionstart", { capture: true }],
    ["compositionend", { capture: true }],
  ]);
  assert.deepEqual(wysiwygB.removed.map(l => [l.type, l.opts]), [
    ["paste", { capture: true }],
  ]);
  assert.deepEqual(existingWysiwyg.removed.map(l => [l.type, l.opts]), [
    ["paste", { capture: true }],
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

test("TitledLinkFeature tolerates getAllEditor throwing during activation via listEditorsSafe", async () => {
  const warnings = [];
  const { mockPlugin, mockSettings, mockContext } = createEditorHost();
  mockContext.logger = { info() {}, warn(msg, err) { warnings.push({ msg, err }); }, error() {}, debug() {} };
  const feature = new TitledLinkFeature(mockPlugin, mockSettings);
  globalThis.__omnikitTestGetAllEditor = () => { throw new TypeError("mobile.editor is undefined"); };
  try {
    await feature.activate(mockContext);
    assert.equal(feature.status, "enabled");
    assert.equal(warnings.length, 1);
    await feature.deactivate();
  } finally {
    delete globalThis.__omnikitTestGetAllEditor;
  }
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

test("C-BUG-01 & C-BUG-02: link and block menus hide extraction items on read-only editors/blocks and exclude .av / NodeAttributeView containers", async () => {
  const { mockPlugin, mockSettings, mockContext, menuContributions } = createEditorHost();
  const feature = new TitledLinkFeature(mockPlugin, mockSettings);
  await feature.activate(mockContext);

  const linkMenu = menuContributions.find(m => m.location === "link");
  const blockMenu = menuContributions.find(m => m.location === "blockicon");

  const makeMockNode = (attrs = {}, parent = null) => {
    const classes = new Set((attrs.class ?? "").split(/\s+/).filter(Boolean));
    const node = {
      parent,
      getAttribute(name) {
        return Object.prototype.hasOwnProperty.call(attrs, name) ? attrs[name] : null;
      },
      matches(selector) {
        return selector.split(",").map(s => s.trim()).some(part => {
          if (part.startsWith(".")) return classes.has(part.slice(1));
          const exactAttr = part.match(/^\[([a-zA-Z0-9_-]+)="([^"]*)"\]$/);
          if (exactAttr) return this.getAttribute(exactAttr[1]) === exactAttr[2];
          const bareAttr = part.match(/^\[([a-zA-Z0-9_-]+)\]$/);
          if (bareAttr) return this.getAttribute(bareAttr[1]) !== null;
          return false;
        });
      },
      closest(selector) {
        let cur = this;
        while (cur) {
          if (cur.matches?.(selector)) return cur;
          cur = cur.parent;
        }
        return null;
      },
    };
    return node;
  };

  const makeBlock = (attrs, linkSpecs) => {
    const block = makeMockNode(attrs);
    const links = linkSpecs.map(spec => {
      const container = spec.containerAttrs ? makeMockNode(spec.containerAttrs, block) : block;
      const link = makeMockNode({ "data-type": "a", "data-href": spec.href, ...(spec.attrs ?? {}) }, container);
      link.textContent = spec.href;
      return link;
    });
    block.querySelectorAll = selector => (selector === 'span[data-type~="a"]' ? links : []);
    block.links = links;
    return block;
  };

  const editableProtyle = { disabled: false, wysiwyg: { element: makeMockNode({ contenteditable: "true" }) } };
  const disabledProtyle = { disabled: true, wysiwyg: { element: makeMockNode({ contenteditable: "false", "data-readonly": "true" }) } };

  const normalBlock = makeBlock({ "data-node-id": "b-edit", contenteditable: "true" }, [
    { href: "https://example.com/editable" },
    { href: "https://example.com/in-av", containerAttrs: { class: "av" } },
  ]);
  const lockedBlock = makeBlock({ "data-node-id": "b-locked", contenteditable: "false" }, [
    { href: "https://example.com/locked" },
  ]);
  const avBlock = makeBlock({ "data-node-id": "b-av", "data-type": "NodeAttributeView" }, [
    { href: "https://example.com/av-cell" },
  ]);

  // 1. Link menu: hidden on disabled editor, locked block, or inside .av
  assert.deepEqual(linkMenu.handler({ detail: { element: normalBlock.links[0], protyle: disabledProtyle } }), []);
  assert.deepEqual(linkMenu.handler({ detail: { element: lockedBlock.links[0], protyle: editableProtyle } }), []);
  assert.deepEqual(linkMenu.handler({ detail: { element: normalBlock.links[1], protyle: editableProtyle } }), []);
  assert.equal(linkMenu.handler({ detail: { element: normalBlock.links[0], protyle: editableProtyle } }).length, 1);

  // 2. Block menu: completely hidden on disabled/read-only document or when only locked / .av blocks are selected
  assert.deepEqual(blockMenu.handler({ detail: { blockElements: [normalBlock], protyle: disabledProtyle } }), []);
  assert.deepEqual(blockMenu.handler({ detail: { blockElements: [lockedBlock, avBlock], protyle: editableProtyle } }), []);

  // 3. Mixed selection counts and forwards only editable non-protected links/blocks
  let batchReceivedBlocks = null;
  feature.controller.runBatch = async blocks => { batchReceivedBlocks = blocks; };
  const batchItems = blockMenu.handler({
    detail: { blockElements: [normalBlock, lockedBlock, avBlock], protyle: editableProtyle },
  });
  assert.equal(batchItems.length, 1);
  assert.equal(batchItems[0].label, "批量提取链接标题 (共 1 个)");
  await batchItems[0].run();
  assert.deepEqual(batchReceivedBlocks, [normalBlock]);

  await feature.deactivate();
});
