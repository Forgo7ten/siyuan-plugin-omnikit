import { test } from "node:test";
import assert from "node:assert/strict";
import {
  ImageCompressionRecordStore,
  imageRecordsFor,
  isRemoteRecordSource,
  recordSourceIdentity,
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
  await assert.rejects(store.upsert("ftp://example.com/original.png", "assets/next.webp"), /asset path/);
  await assert.rejects(store.upsert("https://user:pass@example.com/original.png", "assets/next.webp"), /without credentials/);
  await assert.rejects(store.upsert("assets/original.png", "https://example.com/next.webp"), /asset path/);
  await assert.rejects(store.upsert("assets/original.png?box=bad", "assets/next.webp"), /asset notebook suffix/);
  assert.equal(plugin.writes.length, 1);
});

test("record store supports http(s):// -> assets/... remote localization records with validation and deduplication", async () => {
  assert.equal(isRemoteRecordSource("https://example.com/a.png"), true);
  assert.equal(isRemoteRecordSource("  http://example.com/a.png "), true);
  assert.equal(isRemoteRecordSource("assets/a.png"), false);
  assert.equal(recordSourceIdentity("https://EXAMPLE.com/path/img.png?w=1#top"), "https://example.com/path/img.png?w=1#top");
  assert.throws(() => recordSourceIdentity("https://user:secret@example.com/a.png"), /without credentials/);
  assert.throws(() => recordSourceIdentity("https://example.com/a\u0000.png"), /Invalid compression record remote URL/);
  assert.throws(() => recordSourceIdentity(" https://example.com/a.png"), /Invalid compression record remote URL/);

  const plugin = createPlugin();
  const store = new ImageCompressionRecordStore(plugin, { fetchFn: createFileGetFetch(plugin.storage) });
  await store.init();

  await store.upsert("https://CDN.Example/photo.png?token=1", "assets/photo-1.png");
  await store.upsert("assets/photo-1.png", "assets/photo-1.webp");
  assert.equal(store.snapshot().length, 2);

  await store.markOperation("https://cdn.example/photo.png?token=1", "assets/photo-1.png", "replaced");
  assert.equal(store.snapshot().find(r => r.compressedPath === "assets/photo-1.png")?.lastOperation, "replaced");

  // Same canonical remote URL updates in place instead of creating a duplicate
  await store.upsert("https://cdn.example/photo.png?token=1", "assets/photo-2.png");
  assert.equal(store.snapshot().length, 2);
  assert.equal(store.snapshot()[0].compressedPath, "assets/photo-2.png");

  // Stale compareAndRemove fails; exact match removes only the remote record
  assert.equal(await store.compareAndRemove("https://cdn.example/photo.png?token=1", "assets/photo-1.png"), false);
  assert.equal(await store.compareAndRemove("https://cdn.example/photo.png?token=1", "assets/photo-2.png"), true);
  assert.deepEqual(store.snapshot().map(r => r.originalPath), ["assets/photo-1.png"]);

  // codec.parse rejects credentialed remote URLs and non-asset compressedPath
  for (const badRecord of [
    { originalPath: "https://u:p@example.com/a.png", compressedPath: "assets/a.png", updatedAt: 1, lastOperation: "saved-only" },
    { originalPath: "https://example.com/a.png\n", compressedPath: "assets/a.png", updatedAt: 1, lastOperation: "saved-only" },
    { originalPath: "https://example.com/a.png", compressedPath: "https://example.com/b.webp", updatedAt: 1, lastOperation: "saved-only" },
  ]) {
    const badPlugin = createPlugin(new Map([[
      "feature-image-compressor-records.json",
      { schemaVersion: 1, records: [badRecord] },
    ]]));
    const badStore = new ImageCompressionRecordStore(badPlugin, { fetchFn: createFileGetFetch(badPlugin.storage) });
    await badStore.init();
    assert.equal(badStore.store.needsRecovery, true);
  }
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

test("record store enforces 100 record cap by evicting oldest updatedAt on new inserts without blocking or altering codec parse", async () => {
  const count = 100;
  // Store records in ascending updatedAt order (oldest orig-0 at index 0) to verify updatedAt-based eviction rather than tail pop
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

  // Adding 101st new record succeeds, places new record at index 0, and evicts oldest updatedAt (orig-0)
  await store.upsert("assets/new-extra.png", "assets/new-extra.webp");
  assert.equal(store.snapshot().length, count);
  assert.equal(store.snapshot()[0].originalPath, "assets/new-extra.png");
  assert.equal(store.snapshot().some(r => r.originalPath === "assets/orig-0.png"), false);
  assert.equal(store.snapshot().some(r => r.originalPath === "assets/orig-1.png"), true);

  // In-place update of an existing originalPath succeeds without eviction
  await store.upsert("assets/orig-1.png", "assets/comp-1-v2.webp");
  assert.equal(store.snapshot().length, count);
  assert.equal(store.snapshot()[0].originalPath, "assets/orig-1.png");
  assert.equal(store.snapshot()[0].compressedPath, "assets/comp-1-v2.webp");

  // codec.parse accepts > 100 legacy records without entering read-only recovery
  const overLimitPlugin = createPlugin(new Map([[
    "feature-image-compressor-records.json",
    {
      schemaVersion: 1,
      records: Array.from({ length: 105 }, (_, i) => ({
        originalPath: `assets/over-${i}.png`,
        compressedPath: `assets/over-comp-${i}.webp`,
        updatedAt: 2000 + i,
        lastOperation: "replaced",
      })),
    },
  ]]));
  const overStore = new ImageCompressionRecordStore(overLimitPlugin, { fetchFn: createFileGetFetch(overLimitPlugin.storage) });
  await overStore.init();
  assert.equal(overStore.store.needsRecovery, false);
  assert.equal(overStore.snapshot().length, 105);

  // Inserting into an over-limit legacy store trims it down to 100 keeping newest updatedAt
  await overStore.upsert("assets/over-new.png", "assets/over-new.webp");
  assert.equal(overStore.snapshot().length, 100);
  assert.equal(overStore.snapshot()[0].originalPath, "assets/over-new.png");
  assert.equal(overStore.snapshot().some(r => r.originalPath === "assets/over-0.png"), false);
  assert.equal(overStore.snapshot().some(r => r.originalPath === "assets/over-5.png"), false);
  assert.equal(overStore.snapshot().some(r => r.originalPath === "assets/over-6.png"), true);

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
