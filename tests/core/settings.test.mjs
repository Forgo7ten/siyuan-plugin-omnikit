import { test } from "node:test";
import assert from "node:assert/strict";
import { SettingsManager } from "../../src/core/store/SettingsManager.ts";
import { SettingsConflictError, isSettingsConflictError } from "../../src/core/store/SettingsConflictError.ts";

function plugin() {
  const writes = [];
  const storage = new Map();
  const p = {
    writes, storage, loadDataCalls: 0,
    async loadData(name) { p.loadDataCalls += 1; return storage.get(name) ?? ""; },
    async saveData(name, value) { writes.push(name); storage.set(name, structuredClone(value)); },
  };
  return p;
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

const registrations = [
  {id: "imageCompressor", file: "feature-image-compressor.json", defaultEnabled: true,
    codec: {
      defaults: () => ({schemaVersion: 1, globalEnabled: false, allowlist: {}}),
      parse(input) {
        if (input?.schemaVersion !== 1 || typeof input.globalEnabled !== "boolean") throw new Error("bad image config");
        return structuredClone(input);
      },
    },
  },
  {id: "textTools", file: "feature-text-tools.json", defaultEnabled: false,
    codec: {defaults: () => ({schemaVersion: 1, replacement: ""}), parse: input => structuredClone(input)},
  },
];

test("core/feature settings are separate and feature edits never rewrite core", async () => {
  const p = plugin();
  const settings = new SettingsManager(p, registrations, createFileGetFetch(p.storage));
  await settings.load();
  assert.deepEqual(p.writes, []);
  assert.equal(settings.getFeatureEnabled("imageCompressor", true), true);
  await settings.updateFeature("imageCompressor", config => { config.globalEnabled = true; });
  assert.deepEqual(p.writes, ["feature-image-compressor.json"]);
  await settings.setFeatureEnabled("imageCompressor", false);
  assert.deepEqual(p.writes, ["feature-image-compressor.json", "omnikit-core.json"]);
  await settings.updateFeature("textTools", config => { config.replacement = "yes"; });
  assert.equal(p.writes.at(-1), "feature-text-tools.json");
  assert.equal(p.loadDataCalls, 0);
});

test("settings reset button text and allowlist HPath display conform to unified spec", async () => {
  const { readFile } = await import("node:fs/promises");
  const zh = JSON.parse(await readFile(new URL("../../src/i18n/zh-CN.json", import.meta.url), "utf8"));
  const en = JSON.parse(await readFile(new URL("../../src/i18n/en.json", import.meta.url), "utf8"));
  const panel = await readFile(new URL("../../src/features/image-compressor/ui/ImageSettingsPanel.svelte", import.meta.url), "utf8");
  const allowlistPaths = await readFile(new URL("../../src/features/image-compressor/services/allowlistPaths.ts", import.meta.url), "utf8");

  assert.equal(zh["settings.resetDraft"], "恢复默认值");
  assert.equal(en["settings.resetDraft"], "Restore defaults");
  assert.match(panel, /<strong>\{displayTitle\}<\/strong><small>\{id\}<\/small>/);
  assert.match(allowlistPaths, /SELECT id, box, hpath/);
  assert.match(allowlistPaths, /mode:\s*"readonly"/);
  assert.match(panel, /resolveAllowlistPaths/);
  assert.doesNotMatch(panel, /meta\.title/);
});

test("settings navigation features title uses dedicated i18n key in both locales and SettingsRoot", async () => {
  const { readFile } = await import("node:fs/promises");
  const zh = JSON.parse(await readFile(new URL("../../src/i18n/zh-CN.json", import.meta.url), "utf8"));
  const en = JSON.parse(await readFile(new URL("../../src/i18n/en.json", import.meta.url), "utf8"));
  const sidebar = await readFile(new URL("../../src/ui/settings/SettingsSidebar.svelte", import.meta.url), "utf8");

  assert.equal(zh["nav.features"], "功能模块");
  assert.equal(en["nav.features"], "Features");
  assert.match(sidebar, /<div class="nav-section-title">\{t\("nav\.features"\)\}<\/div>/);
  assert.doesNotMatch(sidebar, /\{t\("status"\)\s*\?\s*"功能模块"\s*:\s*"Features"\}/);
});

test("SettingsManager load settles all stores and reloadAfterExternalChange preserves core-first order", async () => {
  const p = plugin();
  const settings = new SettingsManager(p, registrations, createFileGetFetch(p.storage));
  await settings.load();

  await p.saveData("feature-text-tools.json", { schemaVersion: 1, replacement: "a" });
  await p.saveData("omnikit-core.json", { schemaVersion: 1, general: { debugLog: true, userAgent: "" }, featureStates: {} });
  await p.saveData("feature-image-compressor.json", { schemaVersion: 1, globalEnabled: true, allowlist: {} });

  const changed = await settings.reloadAfterExternalChange();
  assert.deepEqual(changed, ["core", "imageCompressor", "textTools"]);
  assert.equal(p.loadDataCalls, 0);
});

test("SettingsManager.load resolves when stores fail and logs every unreadable store", async () => {
  const p = plugin();
  const baseFetch = createFileGetFetch(p.storage);
  const fetchFn = async (url, request) => {
    const { path } = JSON.parse(request.body);
    if (
      path === "/data/storage/petal/siyuan-plugin-omnikit/omnikit-core.json" ||
      path === "/data/storage/petal/siyuan-plugin-omnikit/feature-text-tools.json"
    ) {
      throw new Error(`read failed: ${path}`);
    }
    return baseFetch(url, request);
  };
  const settings = new SettingsManager(p, registrations, fetchFn);
  const warnings = [];
  const origWarn = console.warn;
  console.warn = (...args) => warnings.push(args.join(" "));
  try {
    await settings.load();
  } finally {
    console.warn = origWarn;
  }

  assert.equal(settings.core.needsRecovery, true);
  assert.equal(settings.store("imageCompressor").needsRecovery, false);
  assert.equal(settings.store("textTools").needsRecovery, true);
  assert.equal(warnings.length, 2);
  assert.match(warnings[0], /omnikit-core\.json/);
  assert.match(warnings[1], /feature-text-tools\.json/);
  assert.equal(p.loadDataCalls, 0);
});

test("isPreferenceReliable separates store reliability from getFeatureEnabled preference", async () => {
  const p = plugin();
  p.storage.set("omnikit-core.json", {
    schemaVersion: 1,
    general: { debugLog: false, userAgent: "" },
    featureStates: {
      imageCompressor: { enabled: true },
      textTools: { enabled: true },
    },
  });
  p.storage.set("feature-image-compressor.json", { schemaVersion: 999 });

  const settings = new SettingsManager(p, registrations, createFileGetFetch(p.storage));
  await settings.load();

  assert.equal(settings.getFeatureEnabled("imageCompressor", false), true);
  assert.equal(settings.getFeatureEnabled("textTools", false), true);
  assert.equal(settings.isPreferenceReliable("imageCompressor"), false);
  assert.equal(settings.isPreferenceReliable("textTools"), true);
  assert.equal(p.loadDataCalls, 0);
});

test("SettingsConflictError carries stable code SETTINGS_CONFLICT", () => {
  const err = new SettingsConflictError("Concurrent edit");
  assert.equal(err.name, "SettingsConflictError");
  assert.equal(err.code, "SETTINGS_CONFLICT");
  assert.equal(isSettingsConflictError(err), true);
  assert.equal(isSettingsConflictError({ code: "SETTINGS_CONFLICT" }), true);
  assert.equal(isSettingsConflictError(new Error("other")), false);
});

test("SettingsRoot preserves recovery guards, UA dirty protection, and describeError formatting", async () => {
  const { readFile } = await import("node:fs/promises");
  const files = [
    "SettingsRoot.svelte",
    "SettingsSidebar.svelte",
    "GeneralSettingsCard.svelte",
    "FeatureSettingsCard.svelte",
    "SettingsSaveBar.svelte",
  ];
  const combined = (
    await Promise.all(files.map(f => readFile(new URL(`../../src/ui/settings/${f}`, import.meta.url), "utf8")))
  ).join("\n");

  assert.match(combined, /disabled=\{globalSaving \|\| coreRecovery \|\| needsFeatureRecovery \|\| !isSupported\}/);
  assert.match(combined, /data-omnikit-field="user-agent"/);
  assert.match(combined, /coreDirty/);
  assert.match(combined, /coreConflict/);
  assert.match(combined, /discardCoreDraftAndReload/);
  assert.match(combined, /preferenceUnreadable/);
  assert.match(combined, /runtime\.preferenceUnreadable/);
  assert.match(combined, /describeError\(/);
  assert.match(combined, /wasRecovering && !nowRecovering && !settings\.core\.needsRecovery && manager/);
  assert.match(combined, /manager\.getStartupError\(id\)/);
  assert.match(combined, /scrollerEl\.scrollTop \+ scrollerEl\.clientHeight >= scrollerEl\.scrollHeight - 4/);
});
