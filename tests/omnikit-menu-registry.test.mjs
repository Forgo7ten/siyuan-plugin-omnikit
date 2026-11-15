import { test } from "node:test";
import assert from "node:assert/strict";
import { FeatureScope } from "../src/core/FeatureScope.ts";
import { MenuRegistry } from "../src/core/MenuRegistry.ts";
import { installMenuRouter } from "../src/core/MenuRouter.ts";

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
  for (const location of ["link", "blockicon"]) {
    registry.contribute(new FeatureScope(), "titledLink", location, location, context => {
      rendered.push({ location: context.location, detail: context.detail });
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
  assert.deepEqual(rendered.map(item => item.location), ["link", "blockicon"]);
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
