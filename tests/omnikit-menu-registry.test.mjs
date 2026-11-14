import { test } from "node:test";
import assert from "node:assert/strict";
import { FeatureScope } from "../src/core/FeatureScope.ts";
import { MenuRegistry } from "../src/core/MenuRegistry.ts";

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
