import { test } from "node:test";
import assert from "node:assert/strict";
import { SettingsManager } from "../src/core/SettingsManager.ts";

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
