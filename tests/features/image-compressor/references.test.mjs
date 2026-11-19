import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { ReferenceService } from "../../../src/features/image-compressor/services/references.ts";

const id = n => `${String(n).padStart(14, "0")}-abcdef0`;

test("reference rewriting never calls workspace-wide relink", async () => {
  const source = await readFile(new URL("../../../src/features/image-compressor/services/references.ts", import.meta.url), "utf8");
  assert.doesNotMatch(source, /relinkAsset/);
  assert.match(source, /commitOccurrence\(target: OccurrenceTarget/);
});

test("reference service does not perform SQL writes or workspace-wide relinking", async () => {
  const source = await readFile(new URL("../../../src/features/image-compressor/services/references.ts", import.meta.url), "utf8");
  assert.doesNotMatch(source, /relinkAsset/);
  assert.doesNotMatch(source, /mode:\s*["']write["']/);
  assert.doesNotMatch(source, /\/api\/query\/sql/);
});

test("ReferenceService.commitOccurrence delegates occurrence-scoped update through SafeBlockWriter", async () => {
  const calls = [];
  const blockID = id(2);
  const rootID = id(1);
  const notebook = id(9);
  const dom = `<div data-node-id="${blockID}"><img data-src="assets/a.png" src="assets/a.png"></div>`;

  const client = {
    async post(url, body) {
      calls.push({ url, body });
      if (url === "/api/block/getBlockInfo") return { code: 0, data: { rootID, box: notebook } };
      if (url === "/api/block/getBlockDOM") return { code: 0, data: { id: blockID, dom } };
      if (url === "/api/block/updateBlock") return { code: 0, data: null };
      throw new Error(`Unexpected endpoint ${url}`);
    },
  };

  const priorDoc = globalThis.document;
  try {
    class MockImg {
      constructor() { this.attrs = { "data-src": "assets/a.png", src: "assets/a.png" }; }
      hasAttribute(n) { return n in this.attrs; }
      getAttribute(n) { return this.attrs[n]; }
      setAttribute(n, v) { this.attrs[n] = v; }
    }
    class MockBlock {
      constructor() { this.img = new MockImg(); }
      getAttribute(n) { return n === "data-node-id" ? blockID : null; }
      querySelectorAll(selector) { return selector === "img" ? [this.img] : []; }
      querySelector() { return null; }
      get outerHTML() { return `<div data-node-id="${blockID}"><img data-src="${this.img.getAttribute("data-src")}" src="${this.img.getAttribute("src")}"></div>`; }
    }
    globalThis.document = {
      createElement: () => {
        const block = new MockBlock();
        return { content: { children: [block] }, set innerHTML(_) {} };
      },
    };

    const service = new ReferenceService(client, "http://localhost:6806");
    const result = await service.commitOccurrence(
      { rootID, notebook, blockID, imageOrdinal: 0, oldPath: "assets/a.png", baselineBlockDOM: dom },
      "assets/a.webp",
    );
    assert.equal(result, "replaced");
    assert.deepEqual(calls.map(c => c.url), ["/api/block/getBlockInfo", "/api/block/getBlockDOM", "/api/block/updateBlock"]);
  } finally {
    globalThis.document = priorDoc;
  }
});
