import { test } from "node:test";
import assert from "node:assert/strict";
import {
  ImageCompressionRecordStore,
  dryRunRecordMigration,
  imageRecordsFor,
  reloadLoadedImageRecords,
} from "../../../src/features/image-compressor/store/ImageCompressionRecordStore.ts";

function createPlugin(storage = new Map()) {
  const writes = [];
  const plugin = {
    writes,
    storage,
    loadDataCalls: 0,
    async loadData(path) {
      plugin.loadDataCalls += 1;
      return storage.has(path) ? structuredClone(storage.get(path)) : "";
    },
    async saveData(path, data) {
      writes.push(path);
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

test("record store persists only validated asset mappings in its data file", async () => {
  const plugin = createPlugin();
  const store = new ImageCompressionRecordStore(plugin, { fetchFn: createFileGetFetch(plugin.storage) });
  await store.init();
  assert.equal(plugin.loadDataCalls, 0);
  await store.upsert("assets/original.png", "assets/compressed.webp");

  assert.deepEqual(plugin.writes, ["feature-image-compressor-records.json"]);
  assert.deepEqual(store.snapshot(), [{
    originalPath: "assets/original.png",
    compressedPath: "assets/compressed.webp",
    updatedAt: store.snapshot()[0].updatedAt,
    lastOperation: "saved-only",
  }]);
  await assert.rejects(store.upsert("https://example.com/original.png", "assets/next.webp"), /asset path/);
  await assert.rejects(store.upsert("assets/original.png?box=bad", "assets/next.webp"), /asset notebook suffix/);
  assert.equal(plugin.writes.length, 1);
});

test("concurrent upserts serialize, replace the latest mapping, and retain independent chains", async () => {
  const plugin = createPlugin();
  const store = new ImageCompressionRecordStore(plugin, { fetchFn: createFileGetFetch(plugin.storage) });
  await store.init();
  assert.equal(plugin.loadDataCalls, 0);
  await Promise.all([
    store.upsert("assets/a.png", "assets/b.webp"),
    store.upsert("assets/a.png", "assets/d.webp"),
    store.upsert("assets/b.webp", "assets/c.webp"),
  ]);

  assert.deepEqual(store.snapshot().map(({ originalPath, compressedPath }) => [originalPath, compressedPath]).sort(), [
    ["assets/a.png", "assets/d.webp"],
    ["assets/b.webp", "assets/c.webp"],
  ].sort());
  assert.equal(plugin.writes.length, 3);
});

test("keeps 100%.png vs 100%25.png and case variants distinct while rejecting exact duplicates without overwriting corrupt data (I-01, F-01)", async () => {
  const distinctPlugin = createPlugin(new Map([[
    "feature-image-compressor-records.json",
    { schemaVersion: 1, records: [
      { originalPath: "assets/100%.png", compressedPath: "assets/one.webp", updatedAt: 1, lastOperation: "saved-only" },
      { originalPath: "assets/100%25.png", compressedPath: "assets/two.webp", updatedAt: 2, lastOperation: "replaced" },
      { originalPath: "assets/Photo.png", compressedPath: "assets/three.webp", updatedAt: 3, lastOperation: "replaced" },
      { originalPath: "assets/photo.png", compressedPath: "assets/four.webp", updatedAt: 4, lastOperation: "replaced" },
    ] },
  ]]));
  const distinctStore = new ImageCompressionRecordStore(distinctPlugin, { fetchFn: createFileGetFetch(distinctPlugin.storage) });
  await distinctStore.init();
  assert.equal(distinctPlugin.loadDataCalls, 0);
  assert.equal(distinctStore.store.needsRecovery, false);
  assert.equal(distinctStore.snapshot().length, 4);

  const corruptPlugin = createPlugin(new Map([[
    "feature-image-compressor-records.json",
    { schemaVersion: 1, records: [
      { originalPath: "assets/dup.png", compressedPath: "assets/one.webp", updatedAt: 1, lastOperation: "saved-only" },
      { originalPath: "assets/dup.png", compressedPath: "assets/two.webp", updatedAt: 2, lastOperation: "replaced" },
    ] },
  ]]));
  const corruptStore = new ImageCompressionRecordStore(corruptPlugin, { fetchFn: createFileGetFetch(corruptPlugin.storage) });
  await corruptStore.init();
  assert.equal(corruptPlugin.loadDataCalls, 0);

  assert.equal(corruptStore.store.needsRecovery, true);
  await assert.rejects(corruptStore.removeRecord("assets/dup.png"), /read-only/);
  assert.deepEqual(corruptPlugin.writes, []);
});

test("upsert and markOperation move updated records to the top of the list (I-19)", async () => {
  const plugin = createPlugin();
  const store = new ImageCompressionRecordStore(plugin, { fetchFn: createFileGetFetch(plugin.storage) });
  await store.init();
  assert.equal(plugin.loadDataCalls, 0);

  await store.upsert("assets/first.png", "assets/first.webp");
  await store.upsert("assets/second.png", "assets/second.webp");
  assert.deepEqual(store.snapshot().map(r => r.originalPath), ["assets/second.png", "assets/first.png"]);

  await store.upsert("assets/first.png", "assets/first-v2.webp");
  assert.deepEqual(store.snapshot().map(r => r.originalPath), ["assets/first.png", "assets/second.png"]);

  await store.markOperation("assets/second.png", "assets/second.webp", "replaced");
  assert.deepEqual(store.snapshot().map(r => r.originalPath), ["assets/second.png", "assets/first.png"]);
  assert.equal(store.snapshot()[0].lastOperation, "replaced");
});

test("compareAndRemove removes only when both originalPath and compressedPath still match (D01)", async () => {
  const plugin = createPlugin();
  const store = new ImageCompressionRecordStore(plugin, { fetchFn: createFileGetFetch(plugin.storage) });
  await store.init();
  assert.equal(plugin.loadDataCalls, 0);
  await store.upsert("assets/a.png", "assets/b.webp");
  await store.upsert("assets/b.webp", "assets/c.webp");

  // Simulate race: A->B updated to A->D before stale cleanup arrives
  await store.upsert("assets/a.png", "assets/d.webp");
  const removedStale = await store.compareAndRemove("assets/a.png", "assets/b.webp");
  assert.equal(removedStale, false);
  assert.equal(store.snapshot().find(r => r.originalPath === "assets/a.png")?.compressedPath, "assets/d.webp");

  // Matching A->D removes ONLY A->D and does not cascade to B->C
  const removedMatch = await store.compareAndRemove("assets/a.png", "assets/d.webp");
  assert.equal(removedMatch, true);
  assert.deepEqual(store.snapshot().map(r => r.originalPath), ["assets/b.webp"]);
});

test("dryRunRecordMigration is read-only and preserves ambiguous or colliding legacy records (I-01)", async () => {
  const records = [
    { originalPath: "assets/a%20b.png", compressedPath: "assets/a%20b.webp", updatedAt: 1, lastOperation: "replaced" },
    { originalPath: "assets/both%20exist.png", compressedPath: "assets/both.webp", updatedAt: 2, lastOperation: "replaced" },
    { originalPath: "assets/missing%20all.png", compressedPath: "assets/missing.webp", updatedAt: 3, lastOperation: "replaced" },
    { originalPath: "assets/collide%20x.png", compressedPath: "assets/cx.webp", updatedAt: 4, lastOperation: "replaced" },
    { originalPath: "assets/collide x.png", compressedPath: "assets/cx2.webp", updatedAt: 5, lastOperation: "replaced" },
  ];
  const present = new Set([
    "assets/a b.png",
    "assets/a b.webp",
    "assets/both%20exist.png",
    "assets/both exist.png",
    "assets/both.webp",
    "assets/collide x.png",
    "assets/cx.webp",
    "assets/cx2.webp",
  ]);
  const report = await dryRunRecordMigration(records, async path => (present.has(path) ? "present" : "unknown"));
  assert.equal(report.migratableCount, 1);
  assert.equal(report.entries[0].canMigrate, true);
  assert.equal(report.entries[0].nextRecord.originalPath, "assets/a b.png");
  assert.equal(report.entries[0].nextRecord.compressedPath, "assets/a b.webp");

  assert.equal(report.entries[1].canMigrate, false);
  assert.equal(report.entries[1].original.status, "ambiguous-both-present");
  assert.equal(report.entries[2].canMigrate, false);
  assert.equal(report.entries[2].original.status, "ambiguous-both-unreachable");
  assert.equal(report.entries[3].canMigrate, false);
  assert.equal(report.entries[3].original.status, "ambiguous-collision");
  assert.ok(report.diagnostics.length >= 3);
});

test("stale status updates cannot overwrite a newer compressed path", async () => {
  const plugin = createPlugin();
  const store = new ImageCompressionRecordStore(plugin, { fetchFn: createFileGetFetch(plugin.storage) });
  await store.init();
  assert.equal(plugin.loadDataCalls, 0);
  await store.upsert("assets/a.png", "assets/old.webp");
  await store.upsert("assets/a.png", "assets/new.webp");
  const writeCount = plugin.writes.length;
  await store.markOperation("assets/a.png", "assets/old.webp", "replaced");

  assert.equal(plugin.writes.length, writeCount);
  assert.equal(store.snapshot()[0].compressedPath, "assets/new.webp");
  assert.equal(store.snapshot()[0].lastOperation, "saved-only");
  await store.markOperation("assets/a.png", "assets/new.webp", "replaced");
  assert.equal(store.snapshot()[0].lastOperation, "replaced");
});

test("a failed save leaves memory unchanged and does not deadlock subsequent writes", async () => {
  const plugin = createPlugin();
  let fail = true;
  plugin.saveData = async path => {
    plugin.writes.push(path);
    if (fail) throw new Error("Save failed");
  };
  const store = new ImageCompressionRecordStore(plugin, { fetchFn: createFileGetFetch(plugin.storage) });
  await store.init();
  assert.equal(plugin.loadDataCalls, 0);

  await assert.rejects(store.upsert("assets/a.png", "assets/a.webp"), /Save failed/);
  assert.deepEqual(store.snapshot(), []);

  // Subsequent write is NOT deadlocked and succeeds when backend recovers
  fail = false;
  await store.upsert("assets/b.png", "assets/b.webp");
  assert.equal(store.snapshot().length, 1);
  assert.equal(store.snapshot()[0].originalPath, "assets/b.png");
  assert.deepEqual(plugin.writes, ["feature-image-compressor-records.json", "feature-image-compressor-records.json"]);
});

test("record store enforces lightweight 10,000 record limit on new inserts without evicting or locking existing records", async () => {
  const count = 10_000;
  const existingRecords = Array.from({ length: count }, (_, i) => ({
    originalPath: `assets/orig-${i}.png`,
    compressedPath: `assets/comp-${i}.webp`,
    updatedAt: 1000 + i,
    lastOperation: "replaced",
  }));
  const plugin = createPlugin(new Map([[
    "feature-image-compressor-records.json",
    { schemaVersion: 1, records: existingRecords },
  ]]));
  const store = new ImageCompressionRecordStore(plugin, { fetchFn: createFileGetFetch(plugin.storage) });
  await store.init();
  assert.equal(plugin.loadDataCalls, 0);

  assert.equal(store.store.needsRecovery, false);
  assert.equal(store.snapshot().length, count);

  const writesAtCap = plugin.writes.length;
  await assert.rejects(store.upsert("assets/new-extra.png", "assets/new-extra.webp"), /10000/);
  assert.equal(store.snapshot().length, count);
  assert.equal(plugin.writes.length, writesAtCap);

  // In-place update of an existing originalPath succeeds without eviction
  await store.upsert("assets/orig-0.png", "assets/comp-0-v2.webp");
  assert.equal(store.snapshot().length, count);
  const updated = store.snapshot().find(r => r.originalPath === "assets/orig-0.png");
  assert.equal(updated?.compressedPath, "assets/comp-0-v2.webp");

  // Identical original and compressed identities are rejected before writing
  const writesBefore = plugin.writes.length;
  await assert.rejects(store.upsert("assets/same.png", "assets/same.png"), /distinct/);
  assert.equal(plugin.writes.length, writesBefore);
});

test("reloadLoadedImageRecords skips uninitialized plugin and reloads initialized store", async () => {
  let loadCalls = 0;
  const uninitializedPlugin = {
    async loadData() { loadCalls++; return ""; },
    async saveData() {},
  };
  await reloadLoadedImageRecords(uninitializedPlugin);
  assert.equal(loadCalls, 0);

  const storage = new Map([[
    "feature-image-compressor-records.json",
    { schemaVersion: 1, records: [{ originalPath: "assets/init.png", compressedPath: "assets/init.webp", updatedAt: 1, lastOperation: "saved-only" }] },
  ]]);
  const initializedPlugin = createPlugin(storage);
  const baseFetch = createFileGetFetch(initializedPlugin.storage);
  let fetchCalls = 0;
  const fetchFn = async (url, request) => {
    fetchCalls += 1;
    return baseFetch(url, request);
  };

  const { store, ready } = imageRecordsFor(initializedPlugin, { fetchFn });
  await ready;
  assert.equal(initializedPlugin.loadDataCalls, 0);
  assert.equal(fetchCalls, 1);
  assert.equal(store.snapshot().length, 1);

  storage.set("feature-image-compressor-records.json", {
    schemaVersion: 1,
    records: [{ originalPath: "assets/init.png", compressedPath: "assets/init-v2.webp", updatedAt: 2, lastOperation: "replaced" }],
  });
  await reloadLoadedImageRecords(initializedPlugin);
  assert.equal(initializedPlugin.loadDataCalls, 0);
  assert.equal(store.snapshot()[0].compressedPath, "assets/init-v2.webp");
  assert.ok(fetchCalls >= 2);
});
