import { test } from "node:test";
import assert from "node:assert/strict";
import {
  ImageCompressionRecordStore,
  imageRecordsFor,
  reloadLoadedImageRecords,
} from "../../../src/features/image-compressor/store/ImageCompressionRecordStore.ts";

function createPlugin(storage = new Map()) {
  const writes = [];
  return {
    writes,
    storage,
    async loadData(path) { return storage.has(path) ? structuredClone(storage.get(path)) : ""; },
    async saveData(path, data) {
      writes.push(path);
      storage.set(path, structuredClone(data));
    },
  };
}

test("record store persists only validated asset mappings in its data file", async () => {
  const plugin = createPlugin();
  const store = new ImageCompressionRecordStore(plugin);
  await store.init();
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
  const store = new ImageCompressionRecordStore(plugin);
  await store.init();
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

test("duplicate originals including case and encoding variants are rejected without overwriting corrupt data", async () => {
  const plugin = createPlugin(new Map([[
    "feature-image-compressor-records.json",
    { schemaVersion: 1, records: [
      { originalPath: "assets/Caf%C3%A9.png", compressedPath: "assets/one.webp", updatedAt: 1, lastOperation: "saved-only" },
      { originalPath: "assets/café.png", compressedPath: "assets/two.webp", updatedAt: 2, lastOperation: "replaced" },
    ] },
  ]]));
  const store = new ImageCompressionRecordStore(plugin);
  await store.init();

  assert.equal(store.store.needsRecovery, true);
  await assert.rejects(store.removeRecord("assets/Caf%C3%A9.png"), /read-only/);
  assert.deepEqual(plugin.writes, []);
});

test("stale status updates cannot overwrite a newer compressed path", async () => {
  const plugin = createPlugin();
  const store = new ImageCompressionRecordStore(plugin);
  await store.init();
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
  const store = new ImageCompressionRecordStore(plugin);
  await store.init();

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
  const store = new ImageCompressionRecordStore(plugin);
  await store.init();

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
  const origLoadData = initializedPlugin.loadData.bind(initializedPlugin);
  initializedPlugin.loadData = async path => { loadCalls++; return origLoadData(path); };

  const { store, ready } = imageRecordsFor(initializedPlugin);
  await ready;
  assert.equal(store.snapshot().length, 1);

  storage.set("feature-image-compressor-records.json", {
    schemaVersion: 1,
    records: [{ originalPath: "assets/init.png", compressedPath: "assets/init-v2.webp", updatedAt: 2, lastOperation: "replaced" }],
  });
  await reloadLoadedImageRecords(initializedPlugin);
  assert.equal(store.snapshot()[0].compressedPath, "assets/init-v2.webp");
  assert.ok(loadCalls >= 2);
});

