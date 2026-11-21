import { test } from "node:test";
import assert from "node:assert/strict";
import { FeatureScope } from "../../src/core/framework/FeatureScope.ts";
import { MenuRegistry } from "../../src/core/feedback/MenuRegistry.ts";
import { installMenuRouter } from "../../src/core/feedback/MenuRouter.ts";
import { imageMenuContributions } from "../../src/features/image-compressor/actions/menuContributions.ts";

test("feature menu labels have one OmniKit prefix and stale clicks show an inactive notice", () => {
  const scope = new FeatureScope();
  let running = true;
  let executed = 0;
  let notices = 0;
  const menu = new MenuRegistry(() => running, error => { throw error; }, undefined, () => notices++);
  menu.contribute(scope, "imageCompressor", "image", "compress", () => [
    { id: "plain", label: "Compress", run: () => executed++ },
    { id: "prefixed", label: "[OmniKit] Preview", run: () => executed++ },
  ]);
  const items = [];
  menu.render("image", { addItem: item => items.push(item) }, { location: "image" });
  assert.deepEqual(items.map(item => item.label), ["[OmniKit] Compress", "[OmniKit] Preview"]);
  items[0].click();
  assert.equal(executed, 1);
  running = false;
  items[1].click();
  assert.equal(executed, 1);
  assert.equal(notices, 1);
});

test("menu contributions dynamically render enable/disable label based on document allowlist", () => {
  const scope = new FeatureScope();
  const allowlist = new Set();
  const getLabel = ctx => allowlist.has(ctx.rootID) ? "关闭当前文档图片自动压缩" : "开启当前文档图片自动压缩";

  const menu = new MenuRegistry(() => true, error => { throw error; });
  menu.contribute(scope, "imageCompressor", "topbar", "toggle-document", ctx => [
    { id: "toggle", label: getLabel(ctx), run: () => {} },
  ]);

  const itemsBefore = [];
  menu.render("topbar", { addItem: item => itemsBefore.push(item) }, { location: "topbar", rootID: "doc-1" });
  assert.equal(itemsBefore[0].label, "开启当前文档图片自动压缩");

  allowlist.add("doc-1");
  const itemsAfter = [];
  menu.render("topbar", { addItem: item => itemsAfter.push(item) }, { location: "topbar", rootID: "doc-1" });
  assert.equal(itemsAfter[0].label, "关闭当前文档图片自动压缩");
});

test("menu labels strip OmniKit prefix in topbar and preserve or prepend in non-topbar menus", () => {
  const scope = new FeatureScope();
  const menu = new MenuRegistry(() => true, error => { throw error; });
  menu.contribute(scope, "imageCompressor", "topbar", "action-1", () => [
    { id: "a", label: "Clean Label", run: () => {} },
    { id: "b", label: "[OmniKit] Redundant Prefix", run: () => {} },
  ]);
  menu.contribute(scope, "imageCompressor", "image", "action-2", () => [
    { id: "c", label: "Clean Label", run: () => {} },
    { id: "d", label: "[OmniKit] Pre-existing Prefix", run: () => {} },
  ]);

  const topbarItems = [];
  menu.render("topbar", { addItem: item => topbarItems.push(item) }, { location: "topbar" });
  assert.deepEqual(topbarItems.map(item => item.label), ["Clean Label", "Redundant Prefix"]);

  const imageItems = [];
  menu.render("image", { addItem: item => imageItems.push(item) }, { location: "image" });
  assert.deepEqual(imageItems.map(item => item.label), ["[OmniKit] Clean Label", "[OmniKit] Pre-existing Prefix"]);
});

test("menu router dispatches link and block icon host contexts", () => {
  const listeners = new Map();
  const plugin = { eventBus: {
    on(name, handler) { listeners.set(name, handler); },
    off(name) { listeners.delete(name); },
  } };
  const registry = new MenuRegistry(() => true, error => { throw error; });
  const rendered = [];
  for (const location of ["link", "blockicon", "doc-title"]) {
    registry.contribute(new FeatureScope(), "titledLink", location, location, context => {
      rendered.push({ location: context.location, detail: context.detail, rootID: context.rootID });
      return [{ id: "run", label: "Run", run: () => {} }];
    });
  }
  const dispose = installMenuRouter(plugin, registry);
  const link = { getAttribute: () => "a", closest: () => ({ getAttribute: () => "block-1" }) };
  const linkMenu = [];
  listeners.get("open-menu-link")({ detail: { element: link, protyle: { block: { rootID: "root-1" } }, menu: { addItem: item => linkMenu.push(item) } } });
  assert.equal(linkMenu[0].label, "[OmniKit] Run");
  const blockMenu = [];
  const blockElements = [{ id: "block-1" }];
  listeners.get("click-blockicon")({ detail: { blockElements, protyle: { block: { rootID: "root-1" } }, menu: { addItem: item => blockMenu.push(item) } } });
  assert.equal(blockMenu[0].label, "[OmniKit] Run");

  // click-editortitleicon with detail.data.rootID fallback
  const titleMenu = [];
  listeners.get("click-editortitleicon")({ detail: { data: { rootID: "doc-from-data-root" }, menu: { addItem: item => titleMenu.push(item) } } });
  assert.equal(titleMenu[0].label, "[OmniKit] Run");
  assert.equal(rendered.find(r => r.location === "doc-title")?.rootID, "doc-from-data-root");

  assert.deepEqual(rendered.map(item => item.location), ["link", "blockicon", "doc-title"]);
  assert.equal(rendered[1].detail.blockElements, blockElements);
  dispose();
  assert.equal(listeners.size, 0);
});

test("link and block icon context menus receive exactly one OmniKit prefix", () => {
  const scope = new FeatureScope();
  const menu = new MenuRegistry(() => true, error => { throw error; });
  menu.contribute(scope, "titled-link", "link", "extract", () => [
    { id: "extract", label: "提取链接标题", run: () => {} },
  ]);
  menu.contribute(scope, "titled-link", "blockicon", "extract-all", () => [
    { id: "extract-all", label: "[OmniKit] 批量提取链接标题 (共 2 个)", run: () => {} },
  ]);

  for (const location of ["link", "blockicon"]) {
    const items = [];
    menu.render(location, { addItem: item => items.push(item) }, { location });
    assert.equal(items.length, 1);
    assert.match(items[0].label, /^\[OmniKit\] /);
    assert.equal(items[0].label.match(/\[OmniKit\]/g)?.length, 1);
  }
});

test("feature-registered matcher filters dynamic context without hardcoded core logic", () => {
  const scope = new FeatureScope();
  const menu = new MenuRegistry(() => true, error => { throw error; });

  // Feature A matches only single document
  menu.contribute(
    scope,
    "featureSingle",
    "doc-tree",
    "single-action",
    () => [{ id: "single", label: "Single Doc Action", run: () => {} }],
    context => context.selectedDocumentCount === 1,
  );

  // Feature B matches multi-document selection (e.g. diff or batch)
  menu.contribute(
    scope,
    "featureMulti",
    "doc-tree",
    "multi-action",
    () => [{ id: "multi", label: "Multi Doc Action", run: () => {} }],
    context => (context.selectedDocumentCount ?? 0) >= 2,
  );

  // Scenario 1: Single document context
  const singleItems = [];
  menu.render("doc-tree", { addItem: item => singleItems.push(item) }, {
    location: "doc-tree",
    rootID: "doc-1",
    selectedDocumentIDs: ["doc-1"],
    selectedDocumentCount: 1,
  });
  assert.equal(singleItems.length, 1);
  assert.equal(singleItems[0].label, "[OmniKit] Single Doc Action");

  // Scenario 2: Multi-document context (3 documents)
  const multiItems = [];
  menu.render("doc-tree", { addItem: item => multiItems.push(item) }, {
    location: "doc-tree",
    selectedDocumentIDs: ["doc-1", "doc-2", "doc-3"],
    selectedDocumentCount: 3,
  });
  assert.equal(multiItems.length, 1);
  assert.equal(multiItems[0].label, "[OmniKit] Multi Doc Action");
});

test("menu router dispatches multi-document selection to context without dropping", () => {
  const listeners = new Map();
  const plugin = { eventBus: {
    on(name, handler) { listeners.set(name, handler); },
    off(name) { listeners.delete(name); },
  } };
  const registry = new MenuRegistry(() => true, error => { throw error; });
  let receivedContext;

  registry.contribute(new FeatureScope(), "multiDocFeature", "doc-tree", "diff", context => {
    receivedContext = context;
    return [{ id: "diff", label: `Compare (${context.selectedDocumentCount})`, run: () => {} }];
  });

  const dispose = installMenuRouter(plugin, registry);

  const docTreeMenu = [];
  listeners.get("open-menu-doctree")({
    detail: {
      type: "doc",
      items: [
        { id: "doc-alpha", type: "navigation-file" },
        { id: "doc-beta", type: "navigation-file" },
      ],
      menu: { addItem: item => docTreeMenu.push(item) },
    },
  });

  assert.equal(docTreeMenu.length, 1);
  assert.equal(docTreeMenu[0].label, "[OmniKit] Compare (2)");
  assert.ok(receivedContext);
  assert.deepEqual(receivedContext.selectedDocumentIDs, ["doc-alpha", "doc-beta"]);
  assert.equal(receivedContext.selectedDocumentCount, 2);
  assert.equal(receivedContext.rootID, undefined);

  const docEl = { getAttribute: key => key === "data-type" ? "navigation-file" : key === "data-node-id" ? "doc-alpha" : null };
  const boxEl = { getAttribute: key => key === "data-type" ? "navigation-root" : key === "data-node-id" ? "box-1" : null };
  listeners.get("open-menu-doctree")({
    detail: {
      type: "items",
      elements: [boxEl, docEl],
      items: [
        { id: "box-1", notebookId: "box-1", path: "/" },
        { id: "doc-alpha", notebookId: "box-1", path: "/doc-alpha.sy" },
      ],
      menu: { addItem: () => {} },
    },
  });
  assert.deepEqual(receivedContext.selectedDocumentIDs, ["doc-alpha"]);
  assert.equal(receivedContext.selectedDocumentCount, 1);
  assert.equal(receivedContext.rootID, undefined);
  assert.equal(receivedContext.targetElement, docEl);

  dispose();
});

test("a throwing matcher skips only its own entry and continues rendering", () => {
  const scope = new FeatureScope();
  const reported = [];
  const debugLogs = [];
  const logger = {
    debug(message, data) { debugLogs.push({ message, data }); },
    info() {},
    warn() {},
    error() {},
  };
  const menu = new MenuRegistry(() => true, error => reported.push(error), logger);

  menu.contribute(
    scope,
    "brokenFeature",
    "doc-tree",
    "broken",
    () => [{ id: "broken", label: "Broken", run: () => {} }],
    () => { throw new Error("matcher failed"); },
  );
  menu.contribute(
    scope,
    "healthyFeature",
    "doc-tree",
    "healthy",
    () => [{ id: "healthy", label: "Healthy", run: () => {} }],
    () => true,
  );

  const items = [];
  menu.render("doc-tree", { addItem: item => items.push(item) }, { location: "doc-tree" });
  assert.equal(items.length, 1);
  assert.equal(items[0].label, "[OmniKit] Healthy");
  assert.equal(reported.length, 1);
  assert.match(reported[0].message, /matcher failed/);
  assert.ok(debugLogs.at(-1)?.data?.跳过项?.some(entry => entry.includes("Matcher 抛错")));
});

function makeFakeElement() {
  const classes = new Set();
  const attrs = new Map();
  const children = [];
  return {
    classes,
    attrs,
    children,
    classList: { add: name => classes.add(name) },
    setAttribute: (name, value) => attrs.set(name, value),
    querySelector: sel => (sel === ".omnikit-menu-checkbox" ? children.find(c => c.className === "omnikit-menu-checkbox") ?? null : null),
    appendChild: node => children.push(node),
  };
}

test("MenuRegistry renders declarative checked items via bind without passing native checked or leaving bind on regular items", () => {
  const prevDocument = globalThis.document;
  globalThis.document = {
    createElement: tag => ({
      tagName: tag.toUpperCase(),
      className: "",
      attrs: new Map(),
      setAttribute(name, value) { this.attrs.set(name, value); },
    }),
  };

  try {
    const scope = new FeatureScope();
    const menu = new MenuRegistry(() => true, error => { throw error; });
    menu.contribute(scope, "imageCompressor", "topbar", "mixed", () => [
      { id: "regular", label: "Regular Action", run: () => {} },
      { id: "checked-true", label: "Whitelist", checked: true, run: () => {} },
      { id: "checked-false", label: "Whitelist", checked: false, run: () => {} },
    ]);

    const items = [];
    menu.render("topbar", { addItem: item => items.push(item) }, { location: "topbar" });
    assert.equal(items.length, 3);

    // Regular item must not carry bind or checked own properties
    assert.equal(Object.hasOwn(items[0], "bind"), false);
    assert.equal(Object.hasOwn(items[0], "checked"), false);

    // Checked items must carry bind and must never pass native checked
    for (const [idx, expected] of [[1, "true"], [2, "false"]]) {
      assert.equal(Object.hasOwn(items[idx], "checked"), false);
      assert.equal(typeof items[idx].bind, "function");
      const el = makeFakeElement();
      items[idx].bind(el);
      assert.equal(el.classes.has("omnikit-whitelist-menu-item"), true);
      assert.equal(el.attrs.get("role"), "menuitemcheckbox");
      assert.equal(el.attrs.get("aria-checked"), expected);
      assert.equal(el.children.length, 1);
      assert.equal(el.children[0].className, "omnikit-menu-checkbox");
      assert.equal(el.children[0].attrs.get("aria-hidden"), "true");
      // Idempotent if bind runs again on the same element
      items[idx].bind(el);
      assert.equal(el.children.length, 1);
    }
  } finally {
    globalThis.document = prevDocument;
  }
});

test("imageMenuContributions guards all 3 whitelist menus by rootID and binds independent checked state", () => {
  const scope = new FeatureScope();
  const allowlist = new Set(["doc-1"]);
  const menu = new MenuRegistry(() => true, error => { throw error; });

  for (const contribution of imageMenuContributions({
    scope,
    context: {},
    t: key => ({
      "menu.whitelistDocument": "当前文档自动压缩",
      "menu.compressDocument": "压缩当前文档全部图片",
      "menu.compressImageQuick": "压缩此图片",
      "menu.compressImageCustom": "压缩…",
    })[key] ?? key,
    icon: "iconOmnikitMenu",
    isAllowlisted: ctx => Boolean(ctx.rootID && allowlist.has(ctx.rootID)),
    compressQuick: async () => {},
    compressCustom: async () => {},
    toggleDocument: async () => {},
    runBatch: async () => {},
  })) {
    menu.contribute(scope, "imageCompressor", contribution.location, contribution.id, contribution.provider);
  }

  for (const location of ["doc-title", "doc-tree", "topbar"]) {
    const withoutRoot = [];
    menu.render(location, { addItem: item => withoutRoot.push(item) }, { location });
    assert.equal(withoutRoot.some(item => item.id.endsWith("toggle-document")), false, `${location} without rootID`);

    const withAllowedRoot = [];
    menu.render(location, { addItem: item => withAllowedRoot.push(item) }, { location, rootID: "doc-1" });
    const toggleAllowed = withAllowedRoot.find(item => item.id.endsWith("toggle-document"));
    assert.ok(toggleAllowed, `${location} with allowlisted rootID`);
    assert.equal(toggleAllowed.label, location === "topbar" ? "当前文档自动压缩" : "[OmniKit] 当前文档自动压缩");
    assert.equal(Object.hasOwn(toggleAllowed, "checked"), false);
    const elAllowed = makeFakeElement();
    toggleAllowed.bind(elAllowed);
    assert.equal(elAllowed.attrs.get("aria-checked"), "true");

    const withOtherRoot = [];
    menu.render(location, { addItem: item => withOtherRoot.push(item) }, { location, rootID: "doc-2" });
    const toggleOther = withOtherRoot.find(item => item.id.endsWith("toggle-document"));
    assert.ok(toggleOther, `${location} with non-allowlisted rootID`);
    const elOther = makeFakeElement();
    toggleOther.bind(elOther);
    assert.equal(elOther.attrs.get("aria-checked"), "false");
  }
});
