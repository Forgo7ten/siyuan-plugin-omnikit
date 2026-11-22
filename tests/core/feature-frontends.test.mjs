import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import {
  isFrontendSupported,
  getCurrentFrontend,
  getFrontendKind,
  setFrontendResolver,
} from "../../src/core/host/Platform.ts";
import { UiFeedback } from "../../src/core/feedback/UiFeedback.ts";
import { BaseFeature } from "../../src/core/framework/BaseFeature.ts";
import { FeatureCatalog } from "../../src/core/framework/FeatureCatalog.ts";
import { FeatureManager } from "../../src/core/framework/FeatureManager.ts";
import { SettingsManager } from "../../src/core/store/SettingsManager.ts";
import { filterSupportedDockViews } from "../../src/ui/dock/registerDock.ts";

function createMockPlugin() {
  const writes = [];
  const storage = new Map();
  const plugin = {
    writes,
    storage,
    loadDataCalls: 0,
    async loadData(name) { plugin.loadDataCalls += 1; return storage.get(name) ?? ""; },
    async saveData(name, value) { writes.push(name); storage.set(name, structuredClone(value)); },
  };
  return plugin;
}

function createFileGetFetch(storage, pluginName = "siyuan-plugin-omnikit") {
  const prefix = `/data/storage/petal/${pluginName}/`;
  return async (url, request) => {
    assert.equal(url, "/api/file/getFile");
    assert.equal(request.method, "POST");
    const { path } = JSON.parse(request.body);
    assert.ok(path.startsWith(prefix), `Unexpected storage path: ${path}`);
    const name = path.slice(prefix.length);
    assert.equal(path, `/data/storage/petal/${pluginName}/${name}`);
    assert.ok(!name.includes("/"));
    if (!storage.has(name)) {
      return new Response(JSON.stringify({ code: 404, msg: "not found" }), { status: 202 });
    }
    const raw = storage.get(name);
    return new Response(typeof raw === "string" ? raw : JSON.stringify(raw), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  };
}

const noopLogger = {
  debug() {},
  info() {},
  warn() {},
  error() {},
};

beforeEach(() => {
  setFrontendResolver(undefined);
});

afterEach(() => {
  setFrontendResolver(undefined);
});

test("isFrontendSupported conforms to SiYuan kernel IsTargetSupported logic across 5+1 frontends", () => {
  const frontends = ["desktop", "desktop-window", "mobile", "browser-desktop", "browser-mobile"];

  // 1. undefined, null, or empty array: supports all frontends
  for (const f of frontends) {
    assert.equal(isFrontendSupported(undefined, f), true, `undefined should support ${f}`);
    assert.equal(isFrontendSupported(null, f), true, `null should support ${f}`);
    assert.equal(isFrontendSupported([], f), true, `empty array should support ${f}`);
  }

  // 2. ["all"] supports all frontends
  for (const f of frontends) {
    assert.equal(isFrontendSupported(["all"], f), true, `["all"] should support ${f}`);
  }

  // 3. Specific whitelist: ["desktop", "desktop-window"]
  const desktopOnly = ["desktop", "desktop-window"];
  assert.equal(isFrontendSupported(desktopOnly, "desktop"), true);
  assert.equal(isFrontendSupported(desktopOnly, "desktop-window"), true);
  assert.equal(isFrontendSupported(desktopOnly, "mobile"), false);
  assert.equal(isFrontendSupported(desktopOnly, "browser-desktop"), false);
  assert.equal(isFrontendSupported(desktopOnly, "browser-mobile"), false);

  // 4. Mobile only
  const mobileOnly = ["mobile", "browser-mobile"];
  assert.equal(isFrontendSupported(mobileOnly, "mobile"), true);
  assert.equal(isFrontendSupported(mobileOnly, "browser-mobile"), true);
  assert.equal(isFrontendSupported(mobileOnly, "desktop"), false);

  // 5. Injected frontend resolver
  setFrontendResolver(() => "mobile");
  assert.equal(getCurrentFrontend(), "mobile");
  assert.equal(isFrontendSupported(desktopOnly), false);
  assert.equal(isFrontendSupported(mobileOnly), true);

  setFrontendResolver(() => "desktop");
  assert.equal(getCurrentFrontend(), "desktop");
  assert.equal(isFrontendSupported(desktopOnly), true);
  assert.equal(isFrontendSupported(mobileOnly), false);

  // 6. getCurrentFrontend ignores "all" and falls back to host sidebar / UA probing
  const prevDoc = globalThis.document;
  try {
    setFrontendResolver(() => "all");
    globalThis.document = { getElementById: id => (id === "sidebar" ? {} : null) };
    assert.equal(getCurrentFrontend(), "mobile");
    assert.equal(getFrontendKind(), "mobile");

    // Lightweight DOM mock without getElementById must not throw
    globalThis.document = { body: { classList: { contains: () => true } } };
    assert.equal(getCurrentFrontend(), "desktop");
    assert.equal(getFrontendKind(), "unknown");
  } finally {
    globalThis.document = prevDoc;
  }
});

test("BaseFeature status reports unsupported on incompatible frontend and blocks activation", async () => {
  setFrontendResolver(() => "mobile");

  const meta = {
    id: "desktop-tool",
    title: "Desktop Tool",
    description: "",
    category: "media",
    icon: "",
    defaultEnabled: true,
    frontends: ["desktop", "desktop-window"],
  };

  let enabledCalled = false;
  class DesktopFeature extends BaseFeature {
    constructor() { super(meta); }
    onEnable() { enabledCalled = true; }
  }

  const feature = new DesktopFeature();
  assert.equal(feature.status, "unsupported");
  assert.equal(feature.enabled, false);

  await assert.rejects(
    async () => feature.activate({ plugin: {}, settings: {}, menus: {}, logger: noopLogger, feedback: new UiFeedback(undefined, () => {}) }),
    /unsupported frontend/
  );
  assert.equal(enabledCalled, false);
});

test("FeatureManager lifecycle skips activation and reports unsupported status", async () => {
  setFrontendResolver(() => "mobile");

  let desktopStarted = false;
  let universalStarted = false;

  class DesktopFeature extends BaseFeature {
    constructor() {
      super({
        id: "desktop-only",
        title: "Desktop Only",
        description: "",
        category: "other",
        icon: "",
        defaultEnabled: true,
        frontends: ["desktop"],
      });
    }
    onEnable() { desktopStarted = true; }
  }

  class UniversalFeature extends BaseFeature {
    constructor() {
      super({
        id: "universal",
        title: "Universal",
        description: "",
        category: "other",
        icon: "",
        defaultEnabled: true,
        frontends: ["all"],
      });
    }
    onEnable() { universalStarted = true; }
  }

  const catalog = new FeatureCatalog();
  catalog.register(new DesktopFeature());
  catalog.register(new UniversalFeature());

  const settings = {
    getFeatureEnabled: () => true,
    isPreferenceReliable: () => true,
    setFeatureEnabled: async () => {},
  };

  const manager = new FeatureManager(catalog, { settings, logger: noopLogger, feedback: new UiFeedback(undefined, () => {}) });
  await manager.initialize();

  assert.equal(desktopStarted, false, "desktop feature should not be started on mobile");
  assert.equal(universalStarted, true, "universal feature should be started on mobile");

  const statuses = manager.statuses();
  const desktopStatus = statuses.find(s => s.id === "desktop-only");
  const universalStatus = statuses.find(s => s.id === "universal");

  assert.equal(desktopStatus?.status, "unsupported");
  assert.equal(universalStatus?.status, "enabled");
  assert.equal(manager.isRunning("desktop-only"), false);
  assert.equal(manager.isRunning("universal"), true);
});

test("setEnabled on unsupported platform returns false and protects omnikit-core.json from corruption", async () => {
  setFrontendResolver(() => "mobile");

  const p = createMockPlugin();
  const registrations = [
    {
      id: "desktopFeature",
      file: "feature-desktop-feature-settings.json",
      defaultEnabled: false,
      frontends: ["desktop"],
      codec: { defaults: () => ({ schemaVersion: 1 }), parse: x => x },
    },
  ];

  const settingsManager = new SettingsManager(p, registrations, createFileGetFetch(p.storage));
  await settingsManager.load();
  assert.equal(p.loadDataCalls, 0);

  class DesktopFeature extends BaseFeature {
    constructor() {
      super({
        id: "desktopFeature",
        title: "Desktop Feature",
        description: "",
        category: "other",
        icon: "",
        defaultEnabled: false,
        frontends: ["desktop"],
      });
    }
    onEnable() {}
  }

  const catalog = new FeatureCatalog();
  catalog.register(new DesktopFeature());

  const manager = new FeatureManager(catalog, {
    plugin: p,
    settings: settingsManager,
    logger: noopLogger,
    feedback: new UiFeedback(undefined, () => {}),
  });

  await manager.initialize();

  // Initial writes during load
  p.writes.length = 0;

  // Attempt to enable the desktop feature while on mobile
  const result = await manager.setEnabled("desktopFeature", true);
  assert.equal(result, false, "setEnabled on unsupported frontend should return false");

  // Verify omnikit-core.json was never written or altered
  assert.equal(p.writes.includes("omnikit-core.json"), false, "omnikit-core.json must not be written when toggle is rejected");
  assert.equal(settingsManager.getFeatureEnabled("desktopFeature", false), false);
  assert.equal(manager.isRunning("desktopFeature"), false);
  assert.equal(manager.statuses()[0].status, "unsupported");
});

test("preserves remote cloud-synced enabled:true preference on unsupported frontend", async () => {
  // Simulate user previously enabled desktopFeature on desktop, so omnikit-core.json has enabled: true
  const p = createMockPlugin();
  p.storage.set("omnikit-core.json", {
    schemaVersion: 1,
    general: { debugLog: false, userAgent: "" },
    featureStates: { desktopFeature: { enabled: true } },
  });

  const registrations = [
    {
      id: "desktopFeature",
      file: "feature-desktop-feature-settings.json",
      defaultEnabled: false,
      frontends: ["desktop"],
      codec: { defaults: () => ({ schemaVersion: 1 }), parse: x => x },
    },
  ];

  // Current client is mobile
  setFrontendResolver(() => "mobile");

  const settingsManager = new SettingsManager(p, registrations, createFileGetFetch(p.storage));
  await settingsManager.load();
  assert.equal(p.loadDataCalls, 0);

  let activateAttempts = 0;
  class DesktopFeature extends BaseFeature {
    constructor() {
      super({
        id: "desktopFeature",
        title: "Desktop Feature",
        description: "",
        category: "other",
        icon: "",
        defaultEnabled: false,
        frontends: ["desktop"],
      });
    }
    onEnable() { activateAttempts++; }
  }

  const catalog = new FeatureCatalog();
  const feature = new DesktopFeature();
  catalog.register(feature);

  const manager = new FeatureManager(catalog, {
    plugin: p,
    settings: settingsManager,
    logger: noopLogger,
    feedback: new UiFeedback(undefined, () => {}),
  });

  // Startup on mobile: skips activation, keeps status unsupported
  await manager.initialize();
  assert.equal(activateAttempts, 0);
  assert.equal(manager.statuses()[0].status, "unsupported");
  // Crucial: The persisted preference in core settings is still enabled: true!
  assert.equal(settingsManager.getFeatureEnabled("desktopFeature", false), true);

  // External sync reload / reconcile
  await manager.reconcileFromLoadedSettings();
  assert.equal(activateAttempts, 0);
  assert.equal(settingsManager.getFeatureEnabled("desktopFeature", false), true);

  // When switching back to desktop:
  setFrontendResolver(() => "desktop");
  assert.equal(feature.status, "disabled"); // now compatible, returns internal phase
  await manager.reconcileFromLoadedSettings();
  assert.equal(activateAttempts, 1);
  assert.equal(manager.isRunning("desktopFeature"), true);
  assert.equal(manager.statuses()[0].status, "enabled");
});

test("filterSupportedDockViews filters views by frontend compatibility", () => {
  const views = [
    { id: "desktop-tool", title: "Desktop Tool", frontends: ["desktop"] },
    { id: "all-tool", title: "All Tool", frontends: ["all"] },
    { id: "omitted-tool", title: "Omitted Tool" },
  ];

  const onMobile = filterSupportedDockViews(views, "mobile");
  assert.deepEqual(onMobile.map(v => v.id), ["all-tool", "omitted-tool"]);

  const onDesktop = filterSupportedDockViews(views, "desktop");
  assert.deepEqual(onDesktop.map(v => v.id), ["desktop-tool", "all-tool", "omitted-tool"]);
});

test("plugin.json frontends includes all five SiYuan frontends", async () => {
  const { readFile } = await import("node:fs/promises");
  const manifest = JSON.parse(await readFile(new URL("../../plugin.json", import.meta.url), "utf8"));
  assert.deepEqual(manifest.frontends, [
    "desktop",
    "desktop-window",
    "mobile",
    "browser-desktop",
    "browser-mobile",
  ]);
  assert.equal(manifest.icon, "icon.png");
  assert.equal(manifest.preview, "preview.png");
});
