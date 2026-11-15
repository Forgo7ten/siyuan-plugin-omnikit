import { test } from "node:test";
import assert from "node:assert/strict";
import { BaseFeature } from "../../src/core/framework/BaseFeature.ts";
import { FeatureScope } from "../../src/core/framework/FeatureScope.ts";

const meta = {
  id: "unitTest", title: "Unit", description: "", category: "other",
  icon: "icon", defaultEnabled: false,
};

test("freeze invalidates old callbacks and still runs onDisable", async () => {
  let cleanups = 0; let shutdowns = 0; let clicks = 0; let signal;
  class Feature extends BaseFeature {
    constructor() { super(meta); }
    onEnable(_ctx, scope) {
      signal = scope.signal;
      scope.own(() => cleanups++);
      this.oldClick = scope.guard(() => clicks++);
    }
    onDisable() { shutdowns++; }
  }
  const feature = new Feature();
  await feature.activate({});
  feature.oldClick();
  feature.freeze();
  assert.equal(signal.aborted, true, "freeze aborts synchronously");
  feature.oldClick();
  await feature.deactivate();
  assert.equal(cleanups, 1);
  assert.equal(clicks, 1);
  assert.equal(shutdowns, 1);
  assert.equal(feature.status, "disabled");
});

test("scope dispose synchronously aborts before releasing owned resources", () => {
  const scope = new FeatureScope();
  let abortedDuringCleanup = false;
  scope.own(() => { abortedDuringCleanup = scope.signal.aborted; });
  scope.dispose();
  assert.equal(scope.signal.aborted, true);
  assert.equal(abortedDuringCleanup, true);
  scope.dispose();
  assert.equal(scope.active, false);
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
