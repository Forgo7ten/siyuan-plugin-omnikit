import { test } from "node:test";
import assert from "node:assert/strict";
import { ImageCompressionRecordStore } from "../src/features/image-compressor/ImageCompressionRecordStore.ts";

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

test("a JsonStore timeout leaves memory unchanged and blocks subsequent writes", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const plugin = createPlugin();
  let entered;
  const saveEntered = new Promise(resolve => { entered = resolve; });
  plugin.saveData = async path => {
    plugin.writes.push(path);
    entered();
    return new Promise(() => {});
  };
  const store = new ImageCompressionRecordStore(plugin);
  await store.init();

  const pending = store.upsert("assets/a.png", "assets/a.webp");
  await saveEntered;
  t.mock.timers.tick(30_000);
  await assert.rejects(pending, /outcome is unconfirmed/);
  assert.deepEqual(store.snapshot(), []);
  await assert.rejects(store.upsert("assets/b.png", "assets/b.webp"), /unconfirmed write/);
  assert.deepEqual(plugin.writes, ["feature-image-compressor-records.json"]);
});

