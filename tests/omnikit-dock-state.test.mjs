import { test } from "node:test";
import assert from "node:assert/strict";
import { dockViewState } from "../src/ui/dock/registerDock.ts";

test("one active feature view renders directly and none shows guidance", () => {
  const image = { id: "image", title: "Images" };
  assert.deepEqual(dockViewState([image]), { selected: image, showTabs: false, empty: false });
  assert.deepEqual(dockViewState([]), { selected: undefined, showTabs: false, empty: true });
});

test("multiple feature views show tabs and retain valid selection", () => {
  const image = { id: "image" }, second = { id: "second" };
  assert.deepEqual(dockViewState([image, second], "second"),
    { selected: second, showTabs: true, empty: false });
  assert.deepEqual(dockViewState([image, second], "disabled"),
    { selected: image, showTabs: true, empty: false });
});
