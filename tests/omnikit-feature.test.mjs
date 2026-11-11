import { test } from "node:test";
import assert from "node:assert/strict";
import { BaseFeature } from "../src/core/BaseFeature.ts";

const meta = {
  id: "unitTest", title: "Unit", description: "", category: "other",
  icon: "icon", defaultEnabled: false,
};

test("freeze invalidates old callbacks and still runs onDisable", async () => {
  let cleanups = 0; let shutdowns = 0; let clicks = 0;
  class Feature extends BaseFeature {
    constructor() { super(meta); }
    onEnable(_ctx, scope) {
      scope.own(() => cleanups++);
      this.oldClick = scope.guard(() => clicks++);
    }
    onDisable() { shutdowns++; }
  }
  const feature = new Feature();
  await feature.activate({});
  feature.oldClick();
  feature.freeze();
  feature.oldClick();
  await feature.deactivate();
  assert.equal(cleanups, 1);
  assert.equal(clicks, 1);
  assert.equal(shutdowns, 1);
  assert.equal(feature.status, "disabled");
});

test("late registrations are cleaned immediately", async () => {
  let cleaned = 0;
  class Feature extends BaseFeature {
    constructor() { super(meta); }
    async onEnable(_ctx, scope) {
      await new Promise(resolve => { this.resolve = resolve; });
      scope.own(() => cleaned++);
    }
    onDisable() {}
  }
  const feature = new Feature();
  const activating = feature.activate({});
  feature.freeze();
  feature.resolve();
  await assert.rejects(activating);
  await feature.deactivate();
  assert.equal(cleaned, 1);
});
