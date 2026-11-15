import { test } from "node:test";
import assert from "node:assert/strict";
import { SettingsManager } from "../../src/core/store/SettingsManager.ts";

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

  assert.equal(zh["settings.resetDraft"], "重置为默认设置");
  assert.equal(en["settings.resetDraft"], "Reset to Default Settings");
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
