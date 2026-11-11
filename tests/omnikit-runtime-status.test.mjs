import { test } from "node:test";
import assert from "node:assert/strict";
import { BaseFeature } from "../src/core/BaseFeature.ts";
import { FeatureCatalog } from "../src/core/FeatureCatalog.ts";
import { FeatureManager } from "../src/core/FeatureManager.ts";

test("status subscribers observe startup failure and retry, and can unsubscribe", async () => {
  const meta = { id: "runtime", title: "Runtime", description: "", category: "other", icon: "", defaultEnabled: true };
  let attempts = 0;
  class Feature extends BaseFeature {
    constructor() { super(meta); }
    async onEnable() {
      attempts++;
      await Promise.resolve();
      if (attempts === 1) throw new Error("startup broke");
    }
  }
  const feature = new Feature();
  const catalog = new FeatureCatalog();
  catalog.register(feature);
  const settings = { getFeatureEnabled: () => true, setFeatureEnabled: async () => {} };
  const manager = new FeatureManager(catalog, { settings, logger: { debug() {}, error() {} } });
  const seen = [];
  const unsubscribe = manager.subscribeStatus(statuses => seen.push(statuses[0]));
  await manager.initialize();
  assert.ok(seen.some(status => status.status === "enabling"));
  assert.equal(seen.at(-1).status, "error");
  assert.equal(seen.at(-1).error, "startup broke");
  assert.equal(await manager.setEnabled(meta.id, true), true);
  assert.equal(seen.at(-1).status, "enabled");
  unsubscribe();
  const count = seen.length;
  await manager.setEnabled(meta.id, false);
  assert.equal(seen.length, count);
});

test("turning off a failed feature clears its runtime error", async () => {
  const meta = { id: "runtime", title: "Runtime", description: "", category: "other", icon: "", defaultEnabled: true };
  class Feature extends BaseFeature { constructor() { super(meta); } onEnable() { throw new Error("broken"); } }
  const catalog = new FeatureCatalog();
  catalog.register(new Feature());
  let desired = true;
  const settings = { getFeatureEnabled: () => desired, setFeatureEnabled: async (_id, value) => { desired = value; } };
  const manager = new FeatureManager(catalog, { settings, logger: { debug() {}, error() {} } });
  await manager.initialize();
  assert.equal(manager.statuses()[0].status, "error");
  assert.equal(await manager.setEnabled(meta.id, false), true);
  assert.equal(manager.statuses()[0].status, "disabled");
  assert.equal(manager.statuses()[0].error, undefined);
});

test("external disable clears failed state and a bad observer cannot block transitions", async () => {
  const meta = { id: "runtime", title: "Runtime", description: "", category: "other", icon: "", defaultEnabled: true };
  class Feature extends BaseFeature { constructor() { super(meta); } onEnable() { throw new Error("broken"); } }
  const catalog = new FeatureCatalog();
  catalog.register(new Feature());
  let desired = true;
  const errors = [];
  const manager = new FeatureManager(catalog, {
    settings: { getFeatureEnabled: () => desired },
    logger: { debug() {}, error(message) { errors.push(message); } },
  });
  manager.subscribeStatus(() => { throw new Error("observer broke"); });
  await manager.initialize();
  desired = false;
  await manager.reconcileFromLoadedSettings();
  assert.equal(manager.statuses()[0].status, "disabled");
  assert.equal(manager.statuses()[0].error, undefined);
  assert.ok(errors.includes("运行状态监听器失败"));
});
