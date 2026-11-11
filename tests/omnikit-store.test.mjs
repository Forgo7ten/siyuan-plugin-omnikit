import { test } from "node:test";
import assert from "node:assert/strict";
import { JsonStore } from "../src/core/JsonStore.ts";

function createPlugin(storage = new Map()) {
  const writes = [];
  let saveResult;
  return {
    writes,
    setSaveResult(value) { saveResult = value; },
    async loadData(path) { return storage.has(path) ? storage.get(path) : ""; },
    async saveData(path, data) {
      writes.push(path);
      if (saveResult !== undefined) return saveResult;
      storage.set(path, structuredClone(data));
    },
  };
}
const codec = {
  defaults: () => ({ schemaVersion: 1, value: 0 }),
  parse(input) {
    if (input?.schemaVersion !== 1 || !Number.isFinite(input.value)) throw new Error("bad schema");
    return { schemaVersion: 1, value: input.value };
  },
};

test("missing settings: load/open/snapshot writes nothing", async () => {
  const plugin = createPlugin();
  const store = new JsonStore(plugin, "feature-unit-test.json", codec);
  await store.load();
  store.snapshot();
  await store.update(() => undefined);
  assert.deepEqual(plugin.writes, []);
});

test("per-file updates are serialized, and no-op writes are skipped", async () => {
  const plugin = createPlugin();
  const store = new JsonStore(plugin, "feature-unit-test.json", codec);
  await store.load();
  await Promise.all(Array.from({ length: 5 }, () => store.update(v => { v.value += 1; })));
  assert.equal(store.snapshot().value, 5);
  assert.equal(plugin.writes.length, 5);
  await store.update(v => { v.value = 5; });
  assert.equal(plugin.writes.length, 5);
});

test("bad settings do not overwrite the raw file", async () => {
  const storage = new Map([["feature-unit-test.json", {schemaVersion: 999, value: 4}]]);
  const plugin = createPlugin(storage);
  const store = new JsonStore(plugin, "feature-unit-test.json", codec);
  await store.load();
  assert.equal(store.needsRecovery, true);
  assert.deepEqual(plugin.writes, []);
  await assert.rejects(store.update(v => { v.value += 1; }));
  assert.deepEqual(plugin.writes, []);
});

test("failed backup response leaves corrupt settings untouched", async () => {
  const raw = {schemaVersion: 999, value: 4};
  const storage = new Map([["feature-unit-test.json", raw]]);
  const plugin = createPlugin(storage);
  const store = new JsonStore(plugin, "feature-unit-test.json", codec);
  await store.load();
  plugin.setSaveResult({code: -1});
  await assert.rejects(store.recoverWithBackup(), /failed to back up/);
  assert.equal(plugin.writes.length, 1);
  assert.match(plugin.writes[0], /^feature-unit-test\.backup-\d+\.json$/);
  assert.deepEqual(storage.get("feature-unit-test.json"), raw);
  assert.equal(store.needsRecovery, true);
});
