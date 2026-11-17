import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { ReferenceService, scanIndexedDocuments, sqlLiteral } from "../../../src/features/image-compressor/services/references.ts";

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
  const source = await readFile(new URL("../../../src/features/image-compressor/services/references.ts", import.meta.url), "utf8");
  assert.doesNotMatch(source, /relinkAsset/);
  assert.match(source, /commitOccurrence\(target: OccurrenceTarget/);
});

test("reference plans do not perform SQL writes or workspace-wide relinking", async () => {
  const source = await readFile(new URL("../../../src/features/image-compressor/services/references.ts", import.meta.url), "utf8");
  assert.doesNotMatch(source, /relinkAsset/);
  assert.doesNotMatch(source, /mode:\s*["']write["']/);
  assert.match(source, /mode:\s*["']readonly["']/);
});

test("ReferenceService.plan discovers candidate blocks via read-only SQL query", async () => {
  const calls = [];
  const client = {
    async post(url, body) {
      calls.push({ url, body });
      if (url === "/api/query/sql") {
        return { code: 0, data: [{ id: id(2), markdown: "![alt](assets/a.png)" }] };
      }
      if (url === "/api/block/getBlockDOM") {
        return { code: 0, data: { id: id(2), dom: `<div data-node-id="${id(2)}"><img data-src="assets/a.png" src="assets/a.png"></div>` } };
      }
      throw new Error(`Unexpected endpoint ${url}`);
    },
  };

  const priorDoc = globalThis.document;
  const priorParser = globalThis.DOMParser;
  try {
    class MockImg {
      constructor() { this.tagName = "IMG"; this.attrs = { "data-src": "assets/a.png", src: "assets/a.png" }; }
      hasAttribute(n) { return n in this.attrs; }
      getAttribute(n) { return this.attrs[n]; }
      setAttribute(n, v) { this.attrs[n] = v; }
      closest() { return null; }
    }
    class MockBlock {
      constructor(blockId, img) {
        this.tagName = "DIV";
        this.blockId = blockId;
        this.img = img;
      }
      getAttribute(n) { return n === "data-node-id" ? this.blockId : null; }
      querySelectorAll(selector) {
        if (selector === "[data-node-id]") return [];
        if (selector === "img") return [this.img];
        return [];
      }
      querySelector(selector) { return this.querySelectorAll(selector)[0] ?? null; }
      get outerHTML() { return `<div data-node-id="${this.blockId}"><img data-src="${this.img.getAttribute("data-src")}" src="${this.img.getAttribute("src")}"></div>`; }
    }
    class MockDoc {
      constructor(block) {
        this.block = block;
        this.body = { children: [block] };
      }
      querySelector() { return null; }
      querySelectorAll(selector) {
        if (selector === "[data-node-id]") return [this.block];
        return [];
      }
    }
    globalThis.DOMParser = class {
      parseFromString() {
        return new MockDoc(new MockBlock(id(2), new MockImg()));
      }
    };
    globalThis.document = {
      createElement: name => {
        if (name === "template") {
          return {
            content: {
              children: [new MockBlock(id(2), new MockImg())],
              querySelector: () => null,
            },
            set innerHTML(_) {},
          };
        }
        return {};
      },
    };

    const service = new ReferenceService(client, "http://localhost:6806");
    const plan = await service.plan([mapping], seed, 10);
    assert.equal(plan.patches.length, 1);
    assert.equal(plan.patches[0].id, id(2));
    assert.equal(calls[0].url, "/api/query/sql");
    assert.match(calls[0].body.stmt, /SELECT id, markdown FROM blocks WHERE root_id = '.*' AND type = 'p' AND markdown LIKE '%assets\/%'/);
    assert.equal(calls[0].body.mode, "readonly");
  } finally {
    globalThis.DOMParser = priorParser;
    globalThis.document = priorDoc;
  }
});
