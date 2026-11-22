import { test } from "node:test";
import assert from "node:assert/strict";
import { JsonStore } from "../../src/core/store/JsonStore.ts";
import { SettingsManager } from "../../src/core/store/SettingsManager.ts";

function createPlugin(storage = new Map()) {
  const writes = [];
  let saveResult;
  const plugin = {
    writes,
    storage,
    loadDataCalls: 0,
    setSaveResult(value) { saveResult = value; },
    async loadData(path) {
      plugin.loadDataCalls += 1;
      return storage.has(path) ? storage.get(path) : "";
    },
    async saveData(path, data) {
      writes.push(path);
      if (saveResult !== undefined) return saveResult;
      storage.set(path, structuredClone(data));
    },
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

const codec = {
  defaults: () => ({ schemaVersion: 1, value: 0 }),
  parse(input) {
    if (input?.schemaVersion !== 1 || !Number.isFinite(input.value)) throw new Error("bad schema");
    return { schemaVersion: 1, value: input.value };
  },
};

test("missing settings: load/open/snapshot writes nothing", async () => {
  const plugin = createPlugin();
  const store = new JsonStore(plugin, "feature-unit-test.json", codec, createFileGetFetch(plugin.storage));
  await store.load();
  store.snapshot();
  await store.update(() => undefined);
  assert.deepEqual(plugin.writes, []);
  assert.equal(plugin.loadDataCalls, 0);
});

test("per-file updates are serialized, and no-op writes are skipped", async () => {
  const plugin = createPlugin();
  const store = new JsonStore(plugin, "feature-unit-test.json", codec, createFileGetFetch(plugin.storage));
  await store.load();
  await Promise.all(Array.from({ length: 5 }, () => store.update(v => { v.value += 1; })));
  assert.equal(store.snapshot().value, 5);
  assert.equal(plugin.writes.length, 5);
  await store.update(v => { v.value = 5; });
  assert.equal(plugin.writes.length, 5);
  assert.equal(plugin.loadDataCalls, 0);
});

test("bad settings do not overwrite the raw file", async () => {
  const storage = new Map([["feature-unit-test.json", {schemaVersion: 999, value: 4}]]);
  const plugin = createPlugin(storage);
  const store = new JsonStore(plugin, "feature-unit-test.json", codec, createFileGetFetch(plugin.storage));
  await store.load();
  assert.equal(store.needsRecovery, true);
  assert.deepEqual(plugin.writes, []);
  await assert.rejects(store.update(v => { v.value += 1; }));
  assert.deepEqual(plugin.writes, []);
  assert.equal(plugin.loadDataCalls, 0);
});

test("failed backup response leaves corrupt settings untouched", async () => {
  const raw = {schemaVersion: 999, value: 4};
  const storage = new Map([["feature-unit-test.json", raw]]);
  const plugin = createPlugin(storage);
  const store = new JsonStore(plugin, "feature-unit-test.json", codec, createFileGetFetch(plugin.storage));
  await store.load();
  plugin.setSaveResult({code: -1});
  await assert.rejects(store.recoverWithBackup(), /failed to back up/);
  assert.equal(plugin.writes.length, 1);
  assert.match(plugin.writes[0], /^feature-unit-test\.backup-\d+\.json$/);
  assert.deepEqual(storage.get("feature-unit-test.json"), raw);
  assert.equal(store.needsRecovery, true);
  assert.equal(plugin.loadDataCalls, 0);
});

test("failed main save after backup keeps the complete recovery state", async () => {
  const raw = {schemaVersion: 999, value: 4};
  const storage = new Map([["feature-unit-test.json", raw]]);
  const plugin = createPlugin(storage);
  const store = new JsonStore(plugin, "feature-unit-test.json", codec, createFileGetFetch(plugin.storage));
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
  assert.equal(plugin.loadDataCalls, 0);
});

test("concurrent recovery calls share one attempt and do not auto-retry a failed write", async () => {
  const raw = {schemaVersion: 999, value: 4};
  const storage = new Map([["feature-unit-test.json", raw]]);
  const plugin = createPlugin(storage);
  const store = new JsonStore(plugin, "feature-unit-test.json", codec, createFileGetFetch(plugin.storage));
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
  assert.equal(plugin.loadDataCalls, 0);
});

test("recovery is serialized with update and reload", async () => {
  const raw = {schemaVersion: 999, value: 4};
  const storage = new Map([["feature-unit-test.json", raw]]);
  const plugin = createPlugin(storage);
  const store = new JsonStore(plugin, "feature-unit-test.json", codec, createFileGetFetch(plugin.storage));
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
  assert.equal(plugin.loadDataCalls, 0);
});

test("failed update preserves memory state and does not deadlock subsequent writes", async () => {
  const plugin = createPlugin();
  const store = new JsonStore(plugin, "feature-unit-test.json", codec, createFileGetFetch(plugin.storage));
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
  assert.equal(plugin.loadDataCalls, 0);
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
  const store = new JsonStore(plugin, "feature-unit-test.json", codec, createFileGetFetch(plugin.storage));
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
  assert.equal(plugin.loadDataCalls, 0);
});

test("SettingsManager.reloadAfterExternalChange settles all stores when one store reload fails", async () => {
  const storage = new Map();
  let failFeatureA = false;
  let loadDataCalls = 0;
  const plugin = {
    async loadData() {
      loadDataCalls += 1;
      throw new Error("plugin.loadData must never be called");
    },
    async saveData(path, data) {
      storage.set(path, structuredClone(data));
    },
  };
  const baseFetch = createFileGetFetch(storage);
  const fetchFn = async (url, request) => {
    const { path } = JSON.parse(request.body);
    if (failFeatureA && path === "/data/storage/petal/siyuan-plugin-omnikit/feature-a-settings.json") {
      throw new Error("disk read failed");
    }
    return baseFetch(url, request);
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

  const settings = new SettingsManager(plugin, registrations, fetchFn);
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
    assert.equal(loadDataCalls, 0);
  } finally {
    console.warn = origWarn;
  }
});

test("transport failure never falls back to loadData in Node or when window and fetch exist", async () => {
  const storage = new Map([["feature-unit-test.json", { schemaVersion: 1, value: 9 }]]);
  let loadDataCalls = 0;
  const plugin = {
    async loadData(path) {
      loadDataCalls++;
      return storage.get(path) ?? "";
    },
    async saveData() {},
  };

  // Node environment (no globalThis.window): injected failing fetch never falls back to loadData
  const nodeStore = new JsonStore(plugin, "feature-unit-test.json", codec, async () => {
    throw new TypeError("Failed to fetch");
  });
  await assert.rejects(nodeStore.load(), TypeError);
  assert.equal(loadDataCalls, 0);
  assert.equal(nodeStore.needsRecovery, true);
  await assert.rejects(nodeStore.update(v => { v.value = 1; }), /read-only/);

  // Browser-like environment (globalThis.window + globalThis.fetch): never falls back to loadData
  const origWindow = globalThis.window;
  const origFetch = globalThis.fetch;
  globalThis.window = {};
  globalThis.fetch = async () => {
    throw new TypeError("Failed to fetch");
  };
  try {
    const store = new JsonStore(plugin, "feature-unit-test.json", codec);
    await assert.rejects(store.load(), TypeError);
    assert.equal(loadDataCalls, 0);
    assert.equal(store.needsRecovery, true);
    await assert.rejects(store.update(v => { v.value = 1; }), /read-only/);
  } finally {
    if (origWindow === undefined) delete globalThis.window;
    else globalThis.window = origWindow;
    globalThis.fetch = origFetch;
  }
});

test("bare HTTP 404 is treated as a read fault and enters read-only without loadData fallback", async () => {
  let loadDataCalls = 0;
  const plugin = {
    async loadData() {
      loadDataCalls++;
      return "";
    },
    async saveData() {},
  };
  const mockFetch = async () => new Response("Not Found", { status: 404 });
  const store = new JsonStore(plugin, "feature-unit-test.json", codec, mockFetch);

  await assert.rejects(store.load(), /HTTP 404/);
  assert.equal(loadDataCalls, 0);
  assert.equal(store.needsRecovery, true);
  await assert.rejects(store.recoverWithBackup(), /Cannot back up unreadable/);
});

test("HTTP 200 with empty or whitespace body enters read-only and recovers without writing an empty backup", async () => {
  const plugin = createPlugin();
  const mockFetch = async () => new Response("   \n ", { status: 200 });
  const store = new JsonStore(plugin, "feature-unit-test.json", codec, mockFetch);

  await store.load();
  assert.equal(store.needsRecovery, true);
  await assert.rejects(store.update(v => { v.value = 1; }), /read-only/);

  await store.recoverWithBackup();
  assert.equal(store.needsRecovery, false);
  assert.deepEqual(plugin.writes, ["feature-unit-test.json"]);
  assert.deepEqual(plugin.storage.get("feature-unit-test.json"), { schemaVersion: 1, value: 0 });
});

test("stalled response body is aborted by the read deadline", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const plugin = createPlugin();
  let enteredText;
  const textEntered = new Promise(resolve => { enteredText = resolve; });
  const mockFetch = async () => ({
    status: 200,
    ok: true,
    text() {
      enteredText();
      return new Promise(() => {});
    },
  });

  const store = new JsonStore(plugin, "feature-unit-test.json", codec, mockFetch);
  const pending = store.load();
  await textEntered;
  t.mock.timers.tick(30_000);
  await assert.rejects(pending, /Storage read timed out/);
  assert.equal(store.needsRecovery, true);
  await assert.rejects(store.update(() => {}), /read-only/);
});

test("enterReadOnly clears stale rawToBackup when a later reload fails over network", async () => {
  const plugin = createPlugin();
  let mode = "corrupt";
  const mockFetch = async () => {
    if (mode === "corrupt") {
      return new Response("{invalid-json", { status: 200 });
    }
    return new Response("Gateway error", { status: 502 });
  };

  const store = new JsonStore(plugin, "feature-unit-test.json", codec, mockFetch);
  await store.load();
  assert.equal(store.needsRecovery, true);

  mode = "network-fail";
  await assert.rejects(store.reload(), /HTTP 502/);
  assert.equal(store.needsRecovery, true);
  await assert.rejects(store.recoverWithBackup(), /Cannot back up unreadable/);
  assert.deepEqual(plugin.writes, []);
});

test("reload() reports true when only read-only state flips", async () => {
  const plugin = createPlugin();
  let fail = true;
  const mockFetch = async () => {
    if (fail) return new Response("Server Error", { status: 500 });
    return new Response(JSON.stringify({ schemaVersion: 1, value: 0 }), { status: 200 });
  };

  const store = new JsonStore(plugin, "feature-unit-test.json", codec, mockFetch);
  await assert.rejects(store.load(), /HTTP 500/);
  assert.equal(store.needsRecovery, true);

  fail = false;
  const changed = await store.reload();
  assert.equal(changed, true);
  assert.equal(store.needsRecovery, false);

  fail = true;
  await assert.rejects(store.reload(), /HTTP 500/);
  assert.equal(store.needsRecovery, true);
});

test("emit() computes one snapshot per round and prevents external mutation of store state", async () => {
  const plugin = createPlugin();
  const store = new JsonStore(plugin, "feature-unit-test.json", codec, createFileGetFetch(plugin.storage));
  await store.load();

  const seen = [];
  store.subscribe(next => { seen.push(next); });
  store.subscribe(next => { seen.push(next); });
  seen.length = 0;

  await store.update(v => { v.value = 42; });
  assert.equal(seen.length, 2);
  assert.strictEqual(seen[0], seen[1]);
  seen[0].value = 999;
  assert.equal(store.snapshot().value, 42);
  assert.equal(plugin.loadDataCalls, 0);
});
