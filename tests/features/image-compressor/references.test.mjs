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
  const dom = `<div data-node-id="${blockID}" parent-heading="20260101000000-heading"><img data-src="assets/a.png" src="assets/a.png"></div>`;

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
      removeAttribute(n) { delete this.attrs[n]; }
    }
    class MockBlock {
      constructor() { this.img = new MockImg(); this.attrs = { "data-node-id": blockID, "parent-heading": "20260101000000-heading" }; }
      getAttribute(n) { return this.attrs[n] ?? null; }
      removeAttribute(n) { delete this.attrs[n]; }
      querySelectorAll(selector) { return selector === "img" ? [this.img] : []; }
      querySelector() { return null; }
      get outerHTML() {
        const headingAttr = this.attrs["parent-heading"] ? ` parent-heading="${this.attrs["parent-heading"]}"` : "";
        return `<div data-node-id="${blockID}"${headingAttr}><img data-src="${this.img.getAttribute("data-src")}" src="${this.img.getAttribute("src")}"></div>`;
      }
    }
    globalThis.document = {
      createElement: () => {
        const block = new MockBlock();
        return { content: { children: [block] }, set innerHTML(_) {} };
      },
    };

    const domWithHeading = `<div data-node-id="${blockID}" parent-heading="20260101000000-heading"><img data-src="assets/a.png" src="assets/a.png"></div>`;
    const service = new ReferenceService(client, "http://localhost:6806");
    const result = await service.commitOccurrence(
      { rootID, notebook, blockID, imageOrdinal: 0, oldPath: "assets/a.png" },
      "assets/a.webp",
    );
    assert.equal(result, "replaced");
    assert.deepEqual(calls.map(c => c.url), ["/api/block/getBlockInfo", "/api/block/getBlockDOM", "/api/block/updateBlock"]);
    assert.equal(calls[2].body.data.includes("parent-heading"), false);
  } finally {
    globalThis.document = priorDoc;
  }
});

test("I-07 + I-04: ReferenceService.commitOccurrenceDetailed reports conflictReason and maps rejected to failed", async () => {
  const blockID = id(2);
  const rootID = id(1);
  const notebook = id(9);
  const dom = `<div data-node-id="${blockID}" updated="20260101000000"><img data-src="assets/a.png" src="assets/a.png"></div>`;
  const priorDoc = globalThis.document;
  try {
    class MockImg {
      constructor() { this.attrs = { "data-src": "assets/a.png", src: "assets/a.png" }; }
      hasAttribute(n) { return n in this.attrs; }
      getAttribute(n) { return this.attrs[n]; }
      setAttribute(n, v) { this.attrs[n] = v; }
      removeAttribute(n) { delete this.attrs[n]; }
    }
    class MockBlock {
      constructor() { this.img = new MockImg(); this.attrs = { "data-node-id": blockID, updated: "20260101000000" }; }
      getAttribute(n) { return this.attrs[n] ?? null; }
      removeAttribute(n) { delete this.attrs[n]; }
      querySelectorAll(selector) { return selector === "img" ? [this.img] : []; }
      querySelector() { return null; }
      get outerHTML() {
        const updatedAttr = this.attrs.updated ? ` updated="${this.attrs.updated}"` : "";
        return `<div data-node-id="${blockID}"${updatedAttr}><img data-src="${this.img.getAttribute("data-src")}" src="${this.img.getAttribute("src")}"></div>`;
      }
    }
    globalThis.document = {
      createElement: () => {
        const block = new MockBlock();
        return { content: { children: [block] }, set innerHTML(_) {} };
      },
    };

    const okClient = {
      async post(url) {
        if (url === "/api/block/getBlockInfo") return { code: 0, data: { rootID, box: notebook } };
        if (url === "/api/block/getBlockDOM") return { code: 0, data: { id: blockID, dom } };
        if (url === "/api/block/updateBlock") return { code: 0, data: null };
        throw new Error(url);
      },
    };
    const okService = new ReferenceService(okClient, "http://localhost:6806");
    const detailed = await okService.commitOccurrenceDetailed(
      { rootID, notebook, blockID, imageOrdinal: 0, oldPath: "assets/a.png" },
      "assets/a.webp",
    );
    assert.equal(detailed.status, "replaced");

    const conflictDetailed = await okService.commitOccurrenceDetailed(
      { rootID, notebook, blockID, imageOrdinal: 0, oldPath: "assets/other.png" },
      "assets/a.webp",
    );
    assert.equal(conflictDetailed.status, "conflict");
    assert.equal(conflictDetailed.conflictReason, "path-mismatch");

    const rejectedClient = {
      async post(url) {
        if (url === "/api/block/getBlockInfo") return { code: 0, data: { rootID, box: notebook } };
        if (url === "/api/block/getBlockDOM") return { code: 0, data: { id: blockID, dom } };
        if (url === "/api/block/updateBlock") throw Object.assign(new Error("read-only"), { outcome: "rejected", code: -1 });
        throw new Error(url);
      },
    };
    const rejectedService = new ReferenceService(rejectedClient, "http://localhost:6806");
    const failedRes = await rejectedService.commitOccurrence(
      { rootID, notebook, blockID, imageOrdinal: 0, oldPath: "assets/a.png" },
      "assets/a.webp",
    );
    assert.equal(failedRes, "failed");
  } finally {
    globalThis.document = priorDoc;
  }
});
