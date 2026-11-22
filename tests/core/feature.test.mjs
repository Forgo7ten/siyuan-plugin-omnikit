import { test } from "node:test";
import assert from "node:assert/strict";
import { BaseFeature } from "../../src/core/framework/BaseFeature.ts";
import { FeatureScope } from "../../src/core/framework/FeatureScope.ts";
import { UiFeedback } from "../../src/core/feedback/UiFeedback.ts";

const meta = {
  id: "unitTest", title: "Unit", description: "", category: "other",
  icon: "icon", defaultEnabled: false,
};

const createContext = (extra = {}) => ({
  feedback: new UiFeedback(undefined, () => {}),
  ...extra,
});

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
  await feature.activate(createContext());
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
  const activating = feature.activate(createContext());
  feature.freeze();
  feature.resolve();
  await assert.rejects(activating);
  await feature.deactivate();
  assert.equal(cleaned, 1);
});

test("FeatureRegistration reloadData contract is optional and invokable", async () => {
  let reloadedWith = null;
  const registration = {
    id: "testFeature",
    titleKey: "feature.test.title",
    descriptionKey: "feature.test.desc",
    defaultEnabled: true,
    file: "feature-test-settings.json",
    codec: { defaults: () => ({}), parse: (x) => x },
    create: () => ({}),
    settingsView: () => null,
    reloadData: async (plugin) => {
      reloadedWith = plugin;
    },
  };

  assert.equal(typeof registration.reloadData, "function");
  const mockPlugin = { name: "test-plugin" };
  await registration.reloadData?.(mockPlugin);
  assert.equal(reloadedWith, mockPlugin);
});

test("BaseFeature binds scoped UiFeedback in onEnable and silences notices after deactivate", async () => {
  const notices = [];
  let featureFeedback;
  class Feature extends BaseFeature {
    constructor() { super(meta); }
    onEnable(ctx) {
      featureFeedback = ctx.feedback;
      featureFeedback?.notify("启用通知");
    }
  }
  const feature = new Feature();
  const rootFeedback = new UiFeedback(undefined, msg => notices.push(msg));
  await feature.activate({ feedback: rootFeedback });
  assert.equal(notices.length, 1);
  assert.notEqual(featureFeedback, rootFeedback);

  await feature.deactivate();
  featureFeedback?.notify("停用后幽灵通知");
  assert.equal(notices.length, 1);
});

test("BaseFeature deactivate clears previous activation failure while still running onDisable", async () => {
  let disabledCalls = 0;
  class Feature extends BaseFeature {
    constructor() { super(meta); }
    onEnable() { throw new Error("boom"); }
    onDisable() { disabledCalls++; }
  }
  const feature = new Feature();
  await assert.rejects(() => feature.activate(createContext()), /boom/);
  assert.equal(feature.status, "error");
  assert.ok(feature.error instanceof Error);

  await feature.deactivate();
  assert.equal(disabledCalls, 1);
  assert.equal(feature.status, "disabled");
  assert.equal(feature.error, undefined);
});

test("BaseFeature deactivate returns a Promise on concurrent and re-entrant calls without undefined window", async () => {
  let disableCalls = 0;
  let reentrantPromise;
  let releaseDisable;
  const disableBlocked = new Promise(resolve => { releaseDisable = resolve; });

  class Feature extends BaseFeature {
    constructor() { super(meta); }
    onEnable(_ctx, scope) {
      scope.own(() => {
        reentrantPromise = this.deactivate();
      });
    }
    async onDisable() {
      disableCalls++;
      await disableBlocked;
    }
  }

  const feature = new Feature();
  await feature.activate(createContext());

  const first = feature.deactivate();
  const second = feature.deactivate();
  assert.ok(first instanceof Promise);
  assert.strictEqual(reentrantPromise, first);
  assert.strictEqual(second, first);

  releaseDisable();
  await Promise.all([first, second, reentrantPromise]);
  assert.equal(disableCalls, 1);
  assert.equal(feature.status, "disabled");
});

test("deactivate during enabling aborts the scope before awaiting onEnable", async () => {
  let capturedSignal;
  let releaseEnable;
  let disableCalls = 0;
  const enableBlocked = new Promise(resolve => { releaseEnable = resolve; });

  class Feature extends BaseFeature {
    constructor() { super(meta); }
    async onEnable(_ctx, scope) {
      capturedSignal = scope.signal;
      await enableBlocked;
    }
    onDisable() { disableCalls++; }
  }

  const feature = new Feature();
  const activating = feature.activate(createContext());
  assert.equal(feature.status, "enabling");
  assert.equal(capturedSignal.aborted, false);

  const deactivating = feature.deactivate();
  assert.equal(capturedSignal.aborted, true);

  releaseEnable();
  await assert.rejects(activating, /frozen during initialization/);
  await deactivating;
  assert.equal(disableCalls, 1);
  assert.equal(feature.status, "disabled");
});
