import { test } from "node:test";
import assert from "node:assert/strict";
import { JsonStore } from "../../src/core/store/JsonStore.ts";
import { SettingsManager } from "../../src/core/store/SettingsManager.ts";

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

test("failed update preserves memory state and does not deadlock subsequent writes", async () => {
  const plugin = createPlugin();
  const store = new JsonStore(plugin, "feature-unit-test.json", codec);
  await store.load();

  plugin.setSaveResult({ code: -1 });
  await assert.rejects(store.update(value => { value.value = 1; }), /Save failed/);
  assert.equal(store.snapshot().value, 0);

  // Subsequent write is NOT deadlocked and succeeds when backend recovers
  plugin.setSaveResult(undefined);
  const updated = await store.update(value => { value.value = 2; });
  assert.equal(updated, true);
  assert.equal(store.snapshot().value, 2);
  assert.deepEqual(plugin.writes, ["feature-unit-test.json", "feature-unit-test.json"]);
});

test("missing file via HTTP 202 code 404 initializes defaults without entering read-only", async () => {
  const plugin = createPlugin();
  const mockFetch = async () => new Response(JSON.stringify({ code: 404, msg: "file not found" }), {
    status: 202,
    headers: { "Content-Type": "application/json" },
  });

  const store = new JsonStore(plugin, "feature-unit-test.json", codec, mockFetch);
  await store.load();
  assert.equal(store.needsRecovery, false);
  assert.deepEqual(store.snapshot(), { schemaVersion: 1, value: 0 });
  assert.deepEqual(plugin.writes, []);
});

test("server error HTTP 500 triggers read-only protection and rejects load", async () => {
  const plugin = createPlugin();
  const mockFetch = async () => new Response("Internal Server Error", { status: 500 });

  const store = new JsonStore(plugin, "feature-unit-test.json", codec, mockFetch);
  await assert.rejects(store.load(), /Server error reading/);
  assert.equal(store.needsRecovery, true);
  assert.deepEqual(plugin.writes, []);

  // Write operations are blocked in read-only mode
  await assert.rejects(store.update(v => { v.value = 1; }), /read-only/);
});

test("HTTP 202 with non-404 code triggers read-only protection", async () => {
  const plugin = createPlugin();
  const mockFetch = async () => new Response(JSON.stringify({ code: 503, msg: "service unavailable" }), {
    status: 202,
    headers: { "Content-Type": "application/json" },
  });

  const store = new JsonStore(plugin, "feature-unit-test.json", codec, mockFetch);
  await assert.rejects(store.load(), /Kernel getFile failed: 503/);
  assert.equal(store.needsRecovery, true);
  assert.deepEqual(plugin.writes, []);
});

test("storage read timeout triggers read-only protection and unblocks queue", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const plugin = createPlugin();
  let entered;
  const fetchEntered = new Promise(resolve => { entered = resolve; });
  const mockFetch = (_url, init) => {
    entered();
    return new Promise((_, reject) => {
      init?.signal?.addEventListener("abort", () => {
        reject(new Error("Storage read timed out"));
      });
    });
  };

  const store = new JsonStore(plugin, "feature-unit-test.json", codec, mockFetch);
  const pending = store.load();
  await fetchEntered;
  t.mock.timers.tick(30_000);
  await assert.rejects(pending, /Storage read timed out/);
  assert.equal(store.needsRecovery, true);

  // Subsequent queue operation executes and is not deadlocked
  let nextExecuted = false;
  await assert.rejects(store.update(() => { nextExecuted = true; }), /read-only/);
  assert.equal(nextExecuted, false);
});

test("queue unblocks following rejected update", async () => {
  const plugin = createPlugin();
  const mockFetch = async () => new Response(JSON.stringify({ schemaVersion: 1, value: 10 }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });

  const store = new JsonStore(plugin, "feature-unit-test.json", codec, mockFetch);
  await store.load();

  // Failed update
  await assert.rejects(store.update(() => { throw new Error("mutation error"); }), /mutation error/);

  // Next update proceeds without deadlock
  const updated = await store.update(v => { v.value = 20; });
  assert.equal(updated, true);
  assert.equal(store.snapshot().value, 20);
});

test("corrupt file content enters recovery mode and can recover with backup", async () => {
  const plugin = createPlugin();
  const corruptContent = JSON.stringify({ schemaVersion: 999, value: 4 });
  const mockFetch = async () => new Response(corruptContent, {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });

  const store = new JsonStore(plugin, "feature-unit-test.json", codec, mockFetch);
  await store.load();
  assert.equal(store.needsRecovery, true);

  // Recover with backup creates a backup and resets to defaults
  await store.recoverWithBackup();
  assert.equal(store.needsRecovery, false);
  assert.equal(store.snapshot().value, 0);
  assert.equal(plugin.writes.length, 2);
  assert.match(plugin.writes[0], /^feature-unit-test\.backup-\d+\.json$/);
  assert.equal(plugin.writes[1], "feature-unit-test.json");
});

test("saveConfirmed timeout rejects without auto-retry and leaves queue unblocked", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const plugin = createPlugin();
  const store = new JsonStore(plugin, "feature-unit-test.json", codec);
  await store.load();

  let enteredSave;
  const saveEntered = new Promise(resolve => { enteredSave = resolve; });
  const originalSave = plugin.saveData;
  let hangNextSave = true;
  plugin.saveData = (path, data) => {
    plugin.writes.push(path);
    if (hangNextSave) {
      enteredSave();
      return new Promise(() => {});
    }
    return originalSave(path, data);
  };

  const pendingUpdate = store.update(v => { v.value = 42; });
  await saveEntered;
  t.mock.timers.tick(30_000);

  await assert.rejects(pendingUpdate, /Storage save timed out/);
  assert.equal(store.snapshot().value, 0);
  assert.equal(plugin.writes.length, 1);

  // Subsequent update is not deadlocked and succeeds once saveData recovers
  hangNextSave = false;
  plugin.saveData = originalSave;
  const ok = await store.update(v => { v.value = 7; });
  assert.equal(ok, true);
  assert.equal(store.snapshot().value, 7);
});

test("legacy loadData fallback timeout triggers read-only protection and unblocks queue", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const plugin = createPlugin();
  let enteredLoad;
  const loadEntered = new Promise(resolve => { enteredLoad = resolve; });
  plugin.loadData = () => {
    enteredLoad();
    return new Promise(() => {});
  };

  const store = new JsonStore(plugin, "feature-unit-test.json", codec);
  const pending = store.load();
  await loadEntered;
  t.mock.timers.tick(30_000);

  await assert.rejects(pending, /Storage read timed out/);
  assert.equal(store.needsRecovery, true);
  await assert.rejects(store.update(() => {}), /read-only/);
});

test("SettingsManager.reloadAfterExternalChange settles all stores when one store reload fails", async () => {
  const storage = new Map();
  let failFeatureA = false;
  const plugin = {
    async loadData(path) {
      if (failFeatureA && path === "feature-a-settings.json") {
        throw new Error("disk read failed");
      }
      return storage.has(path) ? storage.get(path) : "";
    },
    async saveData(path, data) {
      storage.set(path, structuredClone(data));
    },
  };
  const registrations = [
    {
      id: "featureA",
      file: "feature-a-settings.json",
      defaultEnabled: false,
      codec: { defaults: () => ({ schemaVersion: 1, count: 0 }), parse: x => structuredClone(x) },
    },
    {
      id: "featureB",
      file: "feature-b-settings.json",
      defaultEnabled: false,
      codec: { defaults: () => ({ schemaVersion: 1, label: "init" }), parse: x => structuredClone(x) },
    },
  ];

  const settings = new SettingsManager(plugin, registrations);
  await settings.load();

  await plugin.saveData("omnikit-core.json", {
    schemaVersion: 1,
    general: { debugLog: true, userAgent: "" },
    featureStates: {},
  });
  await plugin.saveData("feature-b-settings.json", { schemaVersion: 1, label: "updated" });
  failFeatureA = true;

  const warnings = [];
  const origWarn = console.warn;
  console.warn = (...args) => warnings.push(args.join(" "));
  try {
    const changed = await settings.reloadAfterExternalChange();
    assert.deepEqual(changed, ["core", "featureB"]);
    assert.equal(settings.getGeneral().debugLog, true);
    assert.equal(settings.getFeature("featureB").label, "updated");
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /featureA/);
  } finally {
    console.warn = origWarn;
  }
});
