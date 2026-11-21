import test from "node:test";
import assert from "node:assert/strict";
import { scanDocumentImages } from "../../../src/features/image-compressor/actions/scanDocumentImages.ts";
import { defaultImageFeatureConfig } from "../../../src/features/image-compressor/policy/parseImageConfig.ts";

const id = n => `${String(n).padStart(14, "0")}-abcdef0`;
function fakeImage(blockID, source) {
  return {
    closest: selector => selector === "[data-node-id]" && blockID ? { getAttribute: () => blockID } : null,
    hasAttribute: name => name === "src",
    getAttribute: name => name === "src" ? source : null,
  };
}
function withParser(images, blocks, run) {
  const prior = globalThis.DOMParser;
  globalThis.DOMParser = class {
    parseFromString() {
      return { querySelector: () => null,
        querySelectorAll: selector => selector === "img" ? images : blocks.map(value => ({ id: value })) };
    }
  };
  try { run(); } finally { globalThis.DOMParser = prior; }
}

test("complete document scan includes nested images and preserves each owning block", () => {
  const blocks = [id(1), id(2), id(3), id(4)];
  const images = [fakeImage(id(2), "assets/a.png"), fakeImage(id(3), "assets/a.png"), fakeImage(id(4), "assets/b.jpg")];
  withParser(images, blocks, () => {
    const result = scanDocumentImages("<complete-kernel-dom/>", "http://localhost:6806", defaultImageFeatureConfig());
    assert.equal(result.scannedBlocks, 4);
    assert.deepEqual(result.occurrences.map(item => [item.blockId, item.source.path]),
      [[id(2), "assets/a.png"], [id(3), "assets/a.png"], [id(4), "assets/b.jpg"]]);
    assert.deepEqual(result.occurrences.map(item => item.imageOrdinal), [0, 0, 0]);
  });
});

test("document scan skips WebP and keeps physical per-block image ordinals", () => {
  const block = id(5);
  const images = [fakeImage(block, "assets/a.webp"), fakeImage(block, "assets/b.png"), fakeImage(block, "assets/c.jpg")];
  withParser(images, [block], () => {
    const result = scanDocumentImages("<complete-kernel-dom/>", "http://localhost:6806", defaultImageFeatureConfig());
    assert.deepEqual(result.occurrences.map(item => [item.source.path, item.imageOrdinal]), [
      ["assets/b.png", 1], ["assets/c.jpg", 2],
    ]);
  });
});

test("document scan rejects a local image without an owning block", () => {
  withParser([fakeImage(null, "assets/orphan.png")], [id(1)], () => {
    assert.throws(() => scanDocumentImages("<incomplete/>", "http://localhost:6806", defaultImageFeatureConfig()), /owning block/);
  });
});

test("document scan includes static WebP when smart compression is enabled", () => {
  const block = id(6);
  const images = [fakeImage(block, "assets/a.webp"), fakeImage(block, "assets/b.png")];
  const smartConfig = defaultImageFeatureConfig();
  smartConfig.compression.smartEnabled = true;

  withParser(images, [block], () => {
    const result = scanDocumentImages("<complete-kernel-dom/>", "http://localhost:6806", smartConfig);
    assert.deepEqual(result.occurrences.map(item => [item.source.path, item.imageOrdinal]), [
      ["assets/a.webp", 0],
      ["assets/b.png", 1],
    ]);
  });
});

test("compressDocumentImages flushes pending transactions and localizes remote images before compressing", async () => {
  const prevDOMParser = globalThis.DOMParser;
  const prevDocument = globalThis.document;
  const prevHTMLElement = globalThis.HTMLElement;
  try {
    const rootID = id(10);
    const blockID = id(11);
    const remoteURL = "https://cdn.example/remote.png";
    let blockImgSrc = remoteURL;
    let flushedBeforeScan = false;
    const callOrder = [];

    const makeBlock = src => ({
      id: blockID,
      getAttribute: name => name === "data-node-id" ? blockID : null,
      querySelector: () => null,
      outerHTML: `<div data-node-id="${blockID}"><img src="${src}" /></div>`,
      querySelectorAll: s => s === "img" ? [makeImg(src)] : [],
    });
    const makeImg = src => ({
      closest: selector => selector === "[data-node-id]" ? makeBlock(src) : null,
      hasAttribute: name => name === "src" || name === "data-src",
      getAttribute: name => (name === "src" || name === "data-src") ? src : null,
    });

    globalThis.HTMLElement = class {};
    globalThis.DOMParser = class {
      parseFromString(html) {
        const imgs = html.includes(remoteURL)
          ? [makeImg(remoteURL)]
          : html.includes("assets/localized.png")
            ? [makeImg("assets/localized.png")]
            : [];
        return {
          querySelector: () => null,
          querySelectorAll: selector => {
            if (selector === "img") return imgs;
            if (selector === "[data-node-id]") {
              return [makeBlock(blockImgSrc)];
            }
            return [];
          },
        };
      }
    };
    globalThis.document = {
      createElement: () => ({
        _html: "",
        set innerHTML(val) { this._html = val; },
        get content() {
          const currentSrc = this._html.includes("assets/localized.png") ? "assets/localized.png" : remoteURL;
          const imgEl = makeImg(currentSrc);
          const rootEl = {
            getAttribute: name => name === "data-node-id" ? blockID : null,
            querySelector: () => null,
            querySelectorAll: s => s === "img" ? [imgEl] : [],
          };
          return {
            children: [rootEl],
            querySelectorAll: () => [],
          };
        },
      }),
    };

    const { compressDocumentImages } = await import("../../../src/features/image-compressor/actions/DocumentBatchAction.ts");
    const pngBytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x01]);
    const commits = [];
    const providedFiles = [];

    const services = {
      origin: "http://localhost:6806",
      mobile: false,
      config: () => defaultImageFeatureConfig(),
      userAgent: () => "TestUA",
      kernel: {
        post: async (path, body) => {
          callOrder.push(path);
          if (path === "/api/block/getBlockInfo") {
            return { code: 0, data: { id: rootID, rootID, box: "nb-1", type: "d" } };
          }
          if (path === "/api/block/getBlockDOM") {
            if (body.id === rootID) {
              flushedBeforeScan = callOrder.includes("flushPendingTransactions");
              return { code: 0, data: { id: rootID, dom: `<div data-node-id="${blockID}"><img src="${remoteURL}" /></div>` } };
            }
            return { code: 0, data: { id: blockID, dom: `<div data-node-id="${blockID}"><img src="${blockImgSrc}" /></div>` } };
          }
          return { code: 0, data: {} };
        },
      },
      reader: {
        read: async () => ({ blob: new Blob([pngBytes], { type: "image/png" }), name: "remote.png" }),
      },
      assets: {
        upload: async () => "assets/localized.png",
      },
      references: {
        commitOccurrence: async (target, nextPath) => {
          commits.push({ oldPath: target.oldPath, nextPath });
          blockImgSrc = nextPath;
          return "replaced";
        },
      },
      records: {
        markOperation: async () => {},
      },
      compressOccurrence: async (_target, _cfg, _sig, opts) => {
        providedFiles.push(opts?.providedFile?.name);
        return { status: "saved", path: "assets/compressed.webp", originalBytes: 100, compressedBytes: 40, reference: "none" };
      },
    };

    const detail = {
      protyle: {
        block: { rootID, box: "nb-1" },
        notebookId: "nb-1",
        flushPendingTransactions: async () => { callOrder.push("flushPendingTransactions"); },
      },
    };
    const context = { logger: { warn() {}, debug() {} } };
    const scope = { active: true, signal: new AbortController().signal };

    const summary = await compressDocumentImages(detail, context, scope, services, { rootID, notebook: "nb-1" });
    assert.equal(flushedBeforeScan, true);
    assert.equal(summary.succeeded, 1);
    assert.equal(summary.skipped, 0);
    assert.deepEqual(commits, [
      { oldPath: remoteURL, nextPath: "assets/localized.png" },
      { oldPath: "assets/localized.png", nextPath: "assets/compressed.webp" },
    ]);
    assert.deepEqual(providedFiles, ["remote.png"]);
  } finally {
    globalThis.DOMParser = prevDOMParser;
    globalThis.document = prevDocument;
    globalThis.HTMLElement = prevHTMLElement;
  }
});

test("I-15 + I-04 + I-07: flushes all active matching editors, verifies expectedBlockDOM on dirty blocks, and counts failed writes", async () => {
  const prevDOMParser = globalThis.DOMParser;
  const prevDocument = globalThis.document;
  try {
    const rootID = id(20);
    const otherRootID = id(21);
    const blockID = id(22);
    const flushOrder = [];
    const docDOM = `<div data-node-id="${rootID}"><div data-node-id="${blockID}"><img src="assets/a.png"/><img src="assets/b.png"/></div></div>`;
    let currentBlockDOM = `<div data-node-id="${blockID}"><img src="assets/a.png"/><img src="assets/b.png"/></div>`;

    const makeImg = src => ({
      closest: sel => sel === "[data-node-id]" ? makeBlock(currentBlockDOM) : null,
      hasAttribute: name => name === "src",
      getAttribute: name => name === "src" ? src : null,
    });
    const makeBlock = html => {
      const srcs = [...html.matchAll(/src="([^"]+)"/g)].map(m => m[1]);
      return {
        getAttribute: name => name === "data-node-id" ? blockID : null,
        removeAttribute() {},
        querySelector: () => null,
        querySelectorAll: sel => sel === "img" ? srcs.map(makeImg) : [],
        outerHTML: html,
      };
    };

    globalThis.DOMParser = class {
      parseFromString(html) {
        const srcs = [...html.matchAll(/src="([^"]+)"/g)].map(m => m[1]);
        const imgs = srcs.map(makeImg);
        return {
          querySelector: () => null,
          querySelectorAll: sel => sel === "img" ? imgs : sel === "[data-node-id]" ? [makeBlock(html)] : [],
        };
      }
    };
    globalThis.document = {
      createElement: () => ({
        _html: "",
        set innerHTML(val) { this._html = val; },
        get content() {
          return { children: [makeBlock(this._html)], querySelectorAll: () => [] };
        },
      }),
    };

    const { compressDocumentImages } = await import("../../../src/features/image-compressor/actions/DocumentBatchAction.ts");
    const sharedPrimary = {
      protyle: { block: { rootID }, disabled: false },
      flushPendingTransactions: async () => { flushOrder.push("primary"); },
    };
    const secondary = {
      protyle: { block: { rootID }, disabled: false },
      flushPendingTransactions: async () => { flushOrder.push("secondary"); },
    };
    const destroyed = {
      destroyed: true,
      protyle: { block: { rootID }, disabled: false },
      flushPendingTransactions: async () => { flushOrder.push("destroyed"); },
    };
    const otherDoc = {
      protyle: { block: { rootID: otherRootID }, disabled: false },
      flushPendingTransactions: async () => { flushOrder.push("other"); },
    };

    const markOps = [];
    const services = {
      origin: "http://localhost:6806",
      mobile: true,
      config: () => defaultImageFeatureConfig(),
      kernel: {
        post: async (path, body) => {
          if (path === "/api/block/getBlockInfo") return { code: 0, data: { id: rootID, rootID, box: "nb-1", type: "d" } };
          if (path === "/api/block/getBlockDOM") {
            return { code: 0, data: { id: body.id, dom: body.id === rootID ? docDOM : currentBlockDOM } };
          }
          throw new Error(path);
        },
      },
      compressOccurrence: async (target) => ({
        status: "saved",
        path: target.oldPath.includes("a.png") ? "assets/a.webp" : "assets/b.webp",
        reference: "not-requested",
        originalBytes: 100,
        compressedBytes: 50,
      }),
      references: {
        commitOccurrenceDetailed: async (target, newPath) => {
          if (newPath === "assets/a.webp") {
            // Simulate concurrent external text edit in the same block after commit
            currentBlockDOM = `<div data-node-id="${blockID}" data-tampered="1"><img src="assets/a.webp"/><img src="assets/b.png"/></div>`;
            return {
              status: "replaced",
              expectedBlockDOM: `<div data-node-id="${blockID}"><img src="assets/a.webp"/><img src="assets/b.png"/></div>`,
            };
          }
          return { status: "failed" };
        },
      },
      records: {
        markOperation: async (orig, comp, status) => { markOps.push({ orig, comp, status }); },
      },
    };

    const summary = await compressDocumentImages(
      { protyle: { block: { rootID, box: "nb-1" }, getInstance: () => sharedPrimary } },
      { logger: { warn() {}, debug() {} } },
      { active: true, signal: new AbortController().signal },
      services,
      {
        rootID,
        notebook: "nb-1",
        getAllEditor: () => [sharedPrimary, secondary, destroyed, otherDoc],
      },
    );

    assert.deepEqual(flushOrder, ["primary", "secondary"]);
    assert.equal(summary.succeeded, 1);
    assert.equal(summary.conflicts, 1);
    assert.equal(summary.failed, 0);

    // Also verify failed write increments summary.failed
    const servicesFail = {
      ...services,
      references: {
        commitOccurrenceDetailed: async () => ({ status: "failed" }),
      },
    };
    const failSummary = await compressDocumentImages(
      {},
      { logger: { warn() {}, debug() {} } },
      { active: true, signal: new AbortController().signal },
      servicesFail,
      { rootID, notebook: "nb-1" },
    );
    assert.equal(failSummary.failed, 2);
    assert.equal(markOps.some(m => m.status === "incomplete"), true);
  } finally {
    globalThis.DOMParser = prevDOMParser;
    globalThis.document = prevDocument;
  }
});
