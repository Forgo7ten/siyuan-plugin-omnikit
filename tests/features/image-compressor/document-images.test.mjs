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
