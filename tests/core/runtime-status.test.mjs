import { test } from "node:test";
import assert from "node:assert/strict";
import { BaseFeature } from "../../src/core/framework/BaseFeature.ts";
import { FeatureCatalog } from "../../src/core/framework/FeatureCatalog.ts";
import { FeatureManager } from "../../src/core/framework/FeatureManager.ts";
import { UiFeedback } from "../../src/core/feedback/UiFeedback.ts";

const noopFeedback = () => new UiFeedback(undefined, () => {});

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
  const settings = { getFeatureEnabled: () => true, isPreferenceReliable: () => true, setFeatureEnabled: async () => {} };
  const manager = new FeatureManager(catalog, { settings, logger: { debug() {}, warn() {}, error() {} }, feedback: noopFeedback() });
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
  const settings = { getFeatureEnabled: () => desired, isPreferenceReliable: () => true, setFeatureEnabled: async (_id, value) => { desired = value; } };
  const manager = new FeatureManager(catalog, { settings, logger: { debug() {}, warn() {}, error() {} }, feedback: noopFeedback() });
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
    settings: { getFeatureEnabled: () => desired, isPreferenceReliable: () => true },
    logger: { debug() {}, warn() {}, error(message) { errors.push(message); } },
    feedback: noopFeedback(),
  });
  manager.subscribeStatus(() => { throw new Error("observer broke"); });
  await manager.initialize();
  desired = false;
  await manager.reconcileFromLoadedSettings();
  assert.equal(manager.statuses()[0].status, "disabled");
  assert.equal(manager.statuses()[0].error, undefined);
  assert.ok(errors.includes("运行状态监听器失败"));
});

test("reconcileFromLoadedSettings does not fire notifySettingsChanged for already-enabled features", async () => {
  const meta = { id: "runtime", title: "Runtime", description: "", category: "other", icon: "", defaultEnabled: true };
  let settingsChangedCalls = 0;
  class Feature extends BaseFeature {
    constructor() { super(meta); }
    onEnable() {}
    onSettingsChanged() { settingsChangedCalls++; }
  }
  const catalog = new FeatureCatalog();
  catalog.register(new Feature());
  const manager = new FeatureManager(catalog, {
    settings: { getFeatureEnabled: () => true, isPreferenceReliable: () => true },
    logger: { debug() {}, warn() {}, error() {} },
    feedback: noopFeedback(),
  });
  await manager.initialize();
  await manager.reconcileFromLoadedSettings();
  assert.equal(settingsChangedCalls, 0);
  await manager.notifySettingsChanged(meta.id);
  assert.equal(settingsChangedCalls, 1);
});

test("startup skips an unreliable preference without writing settings", async () => {
  const meta = { id: "runtime", title: "Runtime", description: "", category: "other", icon: "", defaultEnabled: true };
  let enabledCalls = 0;
  let setCalls = 0;
  const warnings = [];
  class Feature extends BaseFeature {
    constructor() { super(meta); }
    onEnable() { enabledCalls++; }
  }
  const catalog = new FeatureCatalog();
  catalog.register(new Feature());
  const manager = new FeatureManager(catalog, {
    settings: {
      getFeatureEnabled: () => true,
      isPreferenceReliable: () => false,
      setFeatureEnabled: async () => { setCalls++; },
    },
    logger: { debug() {}, warn(message) { warnings.push(message); }, error() {} },
    feedback: noopFeedback(),
  });

  await manager.initialize();
  assert.equal(enabledCalls, 0);
  assert.equal(setCalls, 0);
  assert.equal(manager.statuses()[0].status, "disabled");
  assert.equal(warnings.length, 1);
});

test("reconcileFromLoadedSettings keeps a running feature when its preference is unreadable", async () => {
  const meta = { id: "runtime", title: "Runtime", description: "", category: "other", icon: "", defaultEnabled: true };
  let reliable = true;
  let desired = true;
  let disableCalls = 0;
  const warnings = [];
  class Feature extends BaseFeature {
    constructor() { super(meta); }
    onEnable() {}
    onDisable() { disableCalls++; }
  }
  const catalog = new FeatureCatalog();
  catalog.register(new Feature());
  const manager = new FeatureManager(catalog, {
    settings: {
      getFeatureEnabled: () => desired,
      isPreferenceReliable: () => reliable,
    },
    logger: { debug() {}, warn(message) { warnings.push(message); }, error() {} },
    feedback: noopFeedback(),
  });

  await manager.initialize();
  assert.equal(manager.isRunning(meta.id), true);

  reliable = false;
  desired = false;
  await manager.reconcileFromLoadedSettings();
  assert.equal(manager.isRunning(meta.id), true);
  assert.equal(disableCalls, 0);
  assert.equal(warnings.length, 1);
});

test("statuses formats structured { msg, code } startup errors via describeError", async () => {
  const meta = { id: "runtime", title: "Runtime", description: "", category: "other", icon: "", defaultEnabled: true };
  class Feature extends BaseFeature {
    constructor() { super(meta); }
    onEnable() { throw { msg: "Kernel rejected", code: 500 }; }
  }
  const catalog = new FeatureCatalog();
  catalog.register(new Feature());
  const manager = new FeatureManager(catalog, {
    settings: { getFeatureEnabled: () => true, isPreferenceReliable: () => true },
    logger: { debug() {}, warn() {}, error() {} },
    feedback: noopFeedback(),
  });

  await manager.initialize();
  assert.equal(manager.statuses()[0].status, "error");
  assert.equal(manager.statuses()[0].error, "Kernel rejected (code 500)");
});
