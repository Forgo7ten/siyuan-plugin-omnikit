import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
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
const seed = { id: id(1), root_id: id(1), box: id(9) };

test("reference rewriting never calls workspace-wide relink", async () => {
  const source = await readFile(new URL("../src/features/image-compressor/references.ts", import.meta.url), "utf8");
  assert.doesNotMatch(source, /relinkAsset/);
  assert.match(source, /commitOccurrence\(target: OccurrenceTarget/);
});

test("reference plans do not perform SQL writes or workspace-wide relinking", async () => {
  const source = await readFile(new URL("../src/features/image-compressor/references.ts", import.meta.url), "utf8");
  assert.doesNotMatch(source, /relinkAsset/);
  assert.doesNotMatch(source, /mode:\s*["']write["']/);
  assert.match(source, /mode:\s*["']readonly["']/);
});
