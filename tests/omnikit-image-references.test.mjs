import test from "node:test";
import assert from "node:assert/strict";
import { ReferenceService, scanIndexedDocuments, sqlLiteral } from "../src/features/image-compressor/references.ts";

const id = n => `${String(n).padStart(14, "0")}-abcdef0`;
function clientFor(pages) {
  let call = 0;
  return { client: { post: (url, body) => {
    assert.equal(url, "/api/query/sql");
    assert.match(body.stmt, /ORDER BY id ASC LIMIT 64/);
    return Promise.resolve({ code: 0, data: pages[call++] ?? [], msg: "" });
  } }, calls: () => call };
}

test("SQL literal escapes quotes and rejects NUL", () => {
  assert.equal(sqlLiteral("a'b"), "'a''b'");
  assert.throws(() => sqlLiteral("a\0b"), /NUL/);
});

test("keyset scan continues after a short page until empty", async () => {
  const { client, calls } = clientFor([[{ id: id(1), root_id: id(1), box: id(9) }], [{ id: id(2), root_id: id(2), box: id(9) }], []]);
  const docs = await scanIndexedDocuments(client, 10);
  assert.equal(docs.length, 2);
  assert.equal(calls(), 3);
});

test("keyset scan rejects unordered or repeated rows", async () => {
  const { client } = clientFor([[{ id: id(2), root_id: id(2), box: id(9) }, { id: id(1), root_id: id(1), box: id(9) }]]);
  await assert.rejects(scanIndexedDocuments(client, 10), /unordered/);
});

const mapping = { key: "asset:assets/a.png", oldPath: "assets/a.png", newPath: "assets/a.webp" };
function nativeData(dryRun, lookup = false, references = []) {
  return {
    items: [{ oldPath: mapping.oldPath, newPath: lookup ? "" : mapping.newPath,
      ok: true, reason: "", updated: dryRun ? 0 : 1, references }],
    references, skippedNotebooks: [], unavailableAttributeViews: [], dryRun,
    historyPath: "", updated: dryRun ? 0 : 1,
  };
}
const journal = { beforeCommit: async () => {}, blockState: async () => {} };
const seed = { id: id(1), root_id: id(1), box: id(9) };

test("missing native endpoint enters the SQL compatibility preflight", async () => {
  const paths = [];
  const kernel = { async post(path) {
    paths.push(path);
    if (path === "/api/asset/findAssetReferences") throw Object.assign(new Error("Not Found"), { code: -404 });
    if (path === "/api/notebook/lsNotebooks") return { data: null };
    throw new Error(`Unexpected ${path}`);
  } };
  await assert.rejects(new ReferenceService(kernel, "http://localhost:6806").plan([mapping], seed, 100), /Notebook inventory unavailable/);
  assert.deepEqual(paths, ["/api/asset/findAssetReferences", "/api/notebook/lsNotebooks"]);
});

test("native write error never starts SQL fallback or repeats the write", async () => {
  const paths = [];
  const kernel = { async post(path, body) {
    paths.push(path);
    if (path === "/api/asset/findAssetReferences") return { code: 0, data: nativeData(true, true), msg: "" };
    if (path === "/api/asset/relinkAsset" && body.dryRun) return { code: 0, data: nativeData(true), msg: "" };
    if (path === "/api/asset/relinkAsset") throw new Error("HTTP 404 after write dispatch");
    throw new Error(`Unexpected ${path}`);
  } };
  const service = new ReferenceService(kernel, "http://localhost:6806");
  const plan = await service.plan([mapping], seed, 100);
  const result = await service.commit(plan, journal);
  assert.equal(result.state, "unknown");
  assert.equal(paths.filter(path => path === "/api/asset/relinkAsset").length, 2);
  assert.equal(paths.includes("/api/query/sql"), false);
});

test("native cleanup eligibility requires a verified zero-reference recheck", async () => {
  let lookup = 0;
  const kernel = { async post(path, body) {
    if (path === "/api/asset/findAssetReferences") {
      lookup++;
      return { code: 0, data: nativeData(true, true,
        lookup === 1 ? [{ type: "image", blockID: id(2), rootID: id(1), relinkable: true, reason: "" }] : []), msg: "" };
    }
    if (path === "/api/asset/relinkAsset") return { code: 0, data: nativeData(Boolean(body.dryRun)), msg: "" };
    throw new Error(`Unexpected ${path}`);
  } };
  const service = new ReferenceService(kernel, "http://localhost:6806");
  const plan = await service.plan([mapping], seed, 100);
  const result = await service.commit(plan, journal);
  assert.equal(result.state, "verified");
  assert.equal(result.cleanupEligible, true);
  assert.equal(lookup, 2);
});

test("mappings with ?box= parameter bypass native driver and enter SQL fallback", async () => {
  const boxMapping = { key: "asset:assets/a.png?box=20260101000000-abcdef0", oldPath: "assets/a.png", newPath: "assets/a.webp" };
  const paths = [];
  const kernel = { async post(path) {
    paths.push(path);
    if (path === "/api/notebook/lsNotebooks") return { data: null };
    throw new Error(`Unexpected ${path}`);
  } };
  const service = new ReferenceService(kernel, "http://localhost:6806");
  await assert.rejects(service.plan([boxMapping], seed, 100), /Notebook inventory unavailable/);
  assert.equal(paths.includes("/api/asset/findAssetReferences"), false);
  assert.equal(paths.includes("/api/asset/relinkAsset"), false);
  assert.equal(paths.includes("/api/notebook/lsNotebooks"), true);
});
