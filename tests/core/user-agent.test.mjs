import { test } from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_USER_AGENT, SettingsManager } from "../../src/core/store/SettingsManager.ts";

function plugin(initialCore) {
  const writes = [];
  const storage = new Map(initialCore === undefined ? [] : [["omnikit-core.json", structuredClone(initialCore)]]);
  return {
    writes,
    storage,
    async loadData(name) { return storage.get(name) ?? ""; },
    async saveData(name, value) { writes.push(name); storage.set(name, structuredClone(value)); },
  };
}

const feature = {
  id: "sample",
  file: "feature-sample-settings.json",
  defaultEnabled: true,
  codec: {
    defaults: () => ({ schemaVersion: 1, value: "default" }),
    parse(raw) {
      if (raw?.schemaVersion !== 1 || typeof raw.value !== "string") throw new Error("bad feature config");
      return structuredClone(raw);
    },
  },
};

test("core settings use a modern Chrome User-Agent when the stored value is empty", async () => {
  const settings = new SettingsManager(plugin(), [feature]);
  await settings.load();

  assert.equal(settings.getGeneral().userAgent, "");
  assert.equal(settings.getUserAgent(), DEFAULT_USER_AGENT);
  assert.match(settings.getUserAgent(), /Chrome\/130\.0\.0\.0/);
});

test("core settings read and write a custom global User-Agent", async () => {
  const host = plugin();
  const settings = new SettingsManager(host, [feature]);
  await settings.load();

  await settings.updateGeneral({ userAgent: "OmniKit-Test/1.0" });

  assert.equal(settings.getGeneral().userAgent, "OmniKit-Test/1.0");
  assert.equal(settings.getUserAgent(), "OmniKit-Test/1.0");
  assert.equal(host.storage.get("omnikit-core.json").general.userAgent, "OmniKit-Test/1.0");
  await assert.rejects(
    settings.updateGeneral({ userAgent: "bad\r\nInjected: yes" }),
    /Invalid general User-Agent/,
  );
});

test("schema version 1 settings created before userAgent remain readable", async () => {
  const host = plugin({
    schemaVersion: 1,
    general: { debugLog: true },
    featureStates: {},
  });
  const settings = new SettingsManager(host, [feature]);

  await settings.load();

  assert.deepEqual(settings.getGeneral(), { debugLog: true, userAgent: "" });
  assert.equal(settings.getUserAgent(), DEFAULT_USER_AGENT);
  assert.deepEqual(host.writes, []);
});

test("resetAll restores core and feature settings without touching data files", async () => {
  const host = plugin();
  host.storage.set("feature-sample-records.json", { records: ["keep"] });
  const settings = new SettingsManager(host, [feature]);
  await settings.load();
  await settings.updateGeneral({ debugLog: true, userAgent: "Custom/2.0" });
  await settings.setFeatureEnabled("sample", false);
  await settings.updateFeature("sample", config => { config.value = "changed"; });

  await settings.resetAll();

  assert.deepEqual(settings.core.snapshot(), {
    schemaVersion: 1,
    general: { debugLog: false, userAgent: "" },
    featureStates: {},
  });
  assert.deepEqual(settings.getFeature("sample"), { schemaVersion: 1, value: "default" });
  assert.deepEqual(host.storage.get("feature-sample-records.json"), { records: ["keep"] });
  assert.ok(!host.writes.includes("feature-sample-records.json"));
});
