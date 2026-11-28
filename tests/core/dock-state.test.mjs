import { test } from "node:test";
import assert from "node:assert/strict";
import { dockViewState } from "../../src/ui/dock/registerDock.ts";

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


test("registerDock returns refresh/dispose handle and calls removeDock only on mobile", async () => {
  const { registerDock } = await import("../../src/ui/dock/registerDock.ts");
  const { setFrontendResolver } = await import("../../src/core/host/Platform.ts");
  const removedTypes = [];
  let registeredDef;
  const mockPlugin = {
    addDock(def) { registeredDef = def; },
    removeDock(type) { removedTypes.push(type); },
  };
  try {
    setFrontendResolver(() => "desktop");
    const desktopHandle = registerDock(mockPlugin, {
      type: "omnikit-dock",
      icon: "iconOmnikitMenu",
      title: "OmniKit",
      context: {},
      views: () => [],
      t: k => k,
      openSettings: () => {},
    });
    assert.equal(typeof desktopHandle.refresh, "function");
    assert.equal(typeof desktopHandle.dispose, "function");
    assert.equal(typeof registeredDef.destroy, "function");
    desktopHandle.dispose();
    assert.deepEqual(removedTypes, []);

    setFrontendResolver(() => "mobile");
    const mobileHandle = registerDock(mockPlugin, {
      type: "omnikit-dock",
      icon: "iconOmnikitMenu",
      title: "OmniKit",
      context: {},
      views: () => [],
      t: k => k,
      openSettings: () => {},
    });
    mobileHandle.dispose();
    assert.deepEqual(removedTypes, ["omnikit-dock"]);
  } finally {
    setFrontendResolver(undefined);
  }
});
