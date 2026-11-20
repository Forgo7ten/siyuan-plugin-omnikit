import { test } from "node:test";
import assert from "node:assert/strict";
import { SettingsManager } from "../../src/core/store/SettingsManager.ts";
import { SettingsConflictError, isSettingsConflictError } from "../../src/core/store/SettingsConflictError.ts";

function plugin() {
  const writes = [];
  const storage = new Map();
  return {
    writes, storage,
    async loadData(name) { return storage.get(name) ?? ""; },
    async saveData(name, value) { writes.push(name); storage.set(name, structuredClone(value)); },
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
  const settings = new SettingsManager(p, registrations);
  await settings.load();
  assert.deepEqual(p.writes, []);
  assert.equal(settings.getFeatureEnabled("imageCompressor", true), true);
  await settings.updateFeature("imageCompressor", config => { config.globalEnabled = true; });
  assert.deepEqual(p.writes, ["feature-image-compressor.json"]);
  await settings.setFeatureEnabled("imageCompressor", false);
  assert.deepEqual(p.writes, ["feature-image-compressor.json", "omnikit-core.json"]);
  await settings.updateFeature("textTools", config => { config.replacement = "yes"; });
  assert.equal(p.writes.at(-1), "feature-text-tools.json");
});

test("settings reset button text and allowlist HPath display conform to unified spec", async () => {
  const { readFile } = await import("node:fs/promises");
  const zh = JSON.parse(await readFile(new URL("../../src/i18n/zh-CN.json", import.meta.url), "utf8"));
  const en = JSON.parse(await readFile(new URL("../../src/i18n/en.json", import.meta.url), "utf8"));
  const panel = await readFile(new URL("../../src/features/image-compressor/ui/ImageSettingsPanel.svelte", import.meta.url), "utf8");

  assert.equal(zh["settings.resetDraft"], "设为默认值（未保存）");
  assert.equal(en["settings.resetDraft"], "Reset to defaults (unsaved)");
  assert.match(panel, /<strong>\{displayTitle\}<\/strong><small>\{id\}<\/small>/);
  assert.match(panel, /\/api\/filetree\/getHPathByID/);
});

test("settings navigation features title uses dedicated i18n key in both locales and SettingsRoot", async () => {
  const { readFile } = await import("node:fs/promises");
  const zh = JSON.parse(await readFile(new URL("../../src/i18n/zh-CN.json", import.meta.url), "utf8"));
  const en = JSON.parse(await readFile(new URL("../../src/i18n/en.json", import.meta.url), "utf8"));
  const root = await readFile(new URL("../../src/ui/settings/SettingsRoot.svelte", import.meta.url), "utf8");

  assert.equal(zh["nav.features"], "功能模块");
  assert.equal(en["nav.features"], "Features");
  assert.match(root, /<div class="nav-section-title">\{t\("nav\.features"\)\}<\/div>/);
  assert.doesNotMatch(root, /\{t\("status"\)\s*\?\s*"功能模块"\s*:\s*"Features"\}/);
});

test("SettingsManager load settles all stores and reloadAfterExternalChange preserves core-first order", async () => {
  const p = plugin();
  const settings = new SettingsManager(p, registrations);
  await settings.load();

  await p.saveData("feature-text-tools.json", { schemaVersion: 1, replacement: "a" });
  await p.saveData("omnikit-core.json", { schemaVersion: 1, general: { debugLog: true, userAgent: "" }, featureStates: {} });
  await p.saveData("feature-image-compressor.json", { schemaVersion: 1, globalEnabled: true, allowlist: {} });

  const changed = await settings.reloadAfterExternalChange();
  assert.deepEqual(changed, ["core", "imageCompressor", "textTools"]);
});

test("SettingsManager.load resolves when stores fail and logs every unreadable store", async () => {
  const p = plugin();
  p.loadData = async name => {
    if (name === "omnikit-core.json" || name === "feature-text-tools.json") {
      throw new Error(`read failed: ${name}`);
    }
    return "";
  };
  const settings = new SettingsManager(p, registrations);
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

  const settings = new SettingsManager(p, registrations);
  await settings.load();

  assert.equal(settings.getFeatureEnabled("imageCompressor", false), true);
  assert.equal(settings.getFeatureEnabled("textTools", false), true);
  assert.equal(settings.isPreferenceReliable("imageCompressor"), false);
  assert.equal(settings.isPreferenceReliable("textTools"), true);
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
  const root = await readFile(new URL("../../src/ui/settings/SettingsRoot.svelte", import.meta.url), "utf8");

  assert.match(root, /disabled=\{busy \|\| coreRecovery \|\| needsFeatureRecovery \|\| !isSupported\}/);
  assert.match(root, /data-omnikit-field="user-agent"/);
  assert.match(root, /uaDirty/);
  assert.match(root, /preferenceUnreadable/);
  assert.match(root, /runtime\.preferenceUnreadable/);
  assert.match(root, /describeError\(/);
});
