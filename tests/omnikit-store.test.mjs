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

test("failed main save after backup keeps the complete recovery state", async () => {
  const raw = {schemaVersion: 999, value: 4};
  const storage = new Map([["feature-unit-test.json", raw]]);
  const plugin = createPlugin(storage);
  const store = new JsonStore(plugin, "feature-unit-test.json", codec);
  await store.load();
  const before = store.snapshot();
  let saves = 0;
  plugin.saveData = async (path, data) => {
    plugin.writes.push(path);
    saves += 1;
    if (saves === 1) storage.set(path, structuredClone(data));
    else return {code: -1};
  };

  await assert.rejects(store.recoverWithBackup(), /failed to save/);
  assert.deepEqual(store.snapshot(), before);
  assert.equal(store.needsRecovery, true);
  assert.deepEqual(storage.get("feature-unit-test.json"), raw);
  assert.deepEqual(plugin.writes.map(path => path.replace(/\.backup-\d+\.json$/, ".backup.json")), [
    "feature-unit-test.backup.json", "feature-unit-test.json",
  ]);
});

test("concurrent recovery calls share one attempt and do not auto-retry a failed write", async () => {
  const raw = {schemaVersion: 999, value: 4};
  const storage = new Map([["feature-unit-test.json", raw]]);
  const plugin = createPlugin(storage);
  const store = new JsonStore(plugin, "feature-unit-test.json", codec);
  await store.load();
  let releaseBackup;
  const backupBlocked = new Promise(resolve => { releaseBackup = resolve; });
  let enteredBackup;
  const backupEntered = new Promise(resolve => { enteredBackup = resolve; });
  plugin.saveData = async (path, data) => {
    plugin.writes.push(path);
    if (path !== "feature-unit-test.json") {
      enteredBackup();
      await backupBlocked;
      return {code: -1};
    }
    storage.set(path, structuredClone(data));
  };

  const first = store.recoverWithBackup();
  await backupEntered;
  const duplicate = store.recoverWithBackup();
  releaseBackup();
  await assert.rejects(first, /failed to back up/);
  await assert.rejects(duplicate, /failed to back up/);
  assert.equal(plugin.writes.length, 1);
  assert.equal(store.needsRecovery, true);
});

test("recovery is serialized with update and reload", async () => {
  const raw = {schemaVersion: 999, value: 4};
  const storage = new Map([["feature-unit-test.json", raw]]);
  const plugin = createPlugin(storage);
  const store = new JsonStore(plugin, "feature-unit-test.json", codec);
  await store.load();
  let releaseBackup;
  const backupBlocked = new Promise(resolve => { releaseBackup = resolve; });
  let enteredBackup;
  const backupEntered = new Promise(resolve => { enteredBackup = resolve; });
  plugin.saveData = async (path, data) => {
    plugin.writes.push(path);
    if (path.includes(".backup-")) {
      enteredBackup();
      await backupBlocked;
      storage.set(path, structuredClone(data));
      return;
    }
    storage.set(path, structuredClone(data));
  };

  const recovery = store.recoverWithBackup();
  await backupEntered;
  const update = store.update(v => { v.value = 8; });
  const reload = store.reload();
  releaseBackup();
  await recovery;
  assert.equal(await update, true);
  assert.equal(await reload, false);
  assert.equal(store.snapshot().value, 8);
  assert.deepEqual(plugin.writes.map(path => path === "feature-unit-test.json" ? "main" : "backup"), [
    "backup", "main", "main",
  ]);
});

test("unconfirmed update times out without changing memory or starting another write", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const plugin = createPlugin();
  const store = new JsonStore(plugin, "feature-unit-test.json", codec);
  await store.load();
  let entered;
  const saveEntered = new Promise(resolve => { entered = resolve; });
  plugin.saveData = async path => {
    plugin.writes.push(path);
    entered();
    return new Promise(() => {});
  };
  const pending = store.update(value => { value.value = 1; });
  await saveEntered;
  t.mock.timers.tick(30_000);
  await assert.rejects(pending, /outcome is unconfirmed/);
  assert.equal(store.snapshot().value, 0);
  assert.equal(store.needsRecovery, true);
  await assert.rejects(store.update(value => { value.value = 2; }), /unconfirmed write/);
  assert.deepEqual(plugin.writes, ["feature-unit-test.json"]);
});
