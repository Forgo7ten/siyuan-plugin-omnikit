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

test("document scan skips orphan images without an owning block and ignores literal parsererror elements", () => {
  const validBlock = id(1);
  const prior = globalThis.DOMParser;
  globalThis.DOMParser = class {
    parseFromString() {
      return {
        querySelector: selector => selector === "parsererror" ? { tagName: "PARSERERROR" } : null,
        querySelectorAll: selector => selector === "img"
          ? [fakeImage(null, "assets/orphan.png"), fakeImage(validBlock, "assets/valid.png")]
          : [{ id: validBlock }],
      };
    }
  };
  try {
    const result = scanDocumentImages("<parsererror>literal</parsererror>", "http://localhost:6806", defaultImageFeatureConfig());
    assert.deepEqual(result.occurrences.map(item => [item.blockId, item.source.path]), [[validBlock, "assets/valid.png"]]);
  } finally {
    globalThis.DOMParser = prior;
  }
});

test("compressDocumentImages stays fail-closed when flushPendingTransactions throws and catches getAllEditor failures", async () => {
  const { compressDocumentImages } = await import("../../../src/features/image-compressor/actions/DocumentBatchAction.ts");
  const rootID = id(40);
  const warnings = [];
  let flushCalls = 0;
  const services = {
    origin: "http://localhost:6806",
    mobile: false,
    config: () => defaultImageFeatureConfig(),
    kernel: {
      post: async (path) => {
        if (path === "/api/block/getBlockInfo") return { code: 0, data: { id: rootID, rootID, box: "nb-1", type: "d" } };
        throw new Error(`unexpected kernel call: ${path}`);
      },
    },
  };
  const summary = await compressDocumentImages(
    {
      protyle: {
        block: { rootID, box: "nb-1" },
        flushPendingTransactions: async () => {
          flushCalls += 1;
          throw new DOMException("Host flush aborted", "AbortError");
        },
      },
    },
    { logger: { warn(msg, err) { warnings.push({ msg, err }); }, debug() {} } },
    { active: true, signal: new AbortController().signal },
    services,
    {
      rootID,
      notebook: "nb-1",
      getAllEditor: () => { throw new TypeError("mobile.editor undefined"); },
    },
  );
  assert.equal(flushCalls, 1, "listEditorsSafe must swallow getAllEditor throw so flushPendingTransactions still runs");
  assert.equal(summary.scanComplete, false);
  assert.equal(summary.cancelled, false);
  assert.equal(warnings.some(w => w.msg.includes("枚举已打开编辑器失败")), true);
  assert.equal(
    warnings.some(w => w.msg.includes("扫描当前文档图片失败") && w.err?.name === "AbortError"),
    true,
    "host AbortError from flushPendingTransactions must stay fail-closed",
  );
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
    const upserts = [];
    const markOps = [];
    const copyPrompts = [];

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
        commitOccurrenceDetailed: async (target, nextPath) => {
          commits.push({ oldPath: target.oldPath, nextPath });
          blockImgSrc = nextPath;
          return { status: "replaced" };
        },
      },
      recordsReady: Promise.resolve(),
      records: {
        upsert: async (orig, comp) => { upserts.push({ orig, comp }); },
        markOperation: async (orig, comp, status) => { markOps.push({ orig, comp, status }); },
      },
      ui: {
        copyablePath: p => { copyPrompts.push(p); },
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
    assert.deepEqual(upserts, [{ orig: remoteURL, comp: "assets/localized.png" }]);
    assert.deepEqual(markOps, [
      { orig: remoteURL, comp: "assets/localized.png", status: "replaced" },
      { orig: "assets/localized.png", comp: "assets/compressed.webp", status: "replaced" },
    ]);
    assert.deepEqual(copyPrompts, []);
    assert.deepEqual(providedFiles, ["remote.png"]);

    // Partial conflict in a multi-occurrence remote URL group marks the remote->local record as incomplete
    let commitCallIdx = 0;
    const partialMarkOps = [];
    const blkA = id(12);
    const blkB = id(13);
    const multiDocDom = `<div data-node-id="${blkA}"><img src="${remoteURL}" /></div><div data-node-id="${blkB}"><img src="${remoteURL}" /></div>`;
    const multiServices = {
      ...services,
      kernel: {
        post: async (path, body) => {
          if (path === "/api/block/getBlockInfo") return { code: 0, data: { id: rootID, rootID, box: "nb-1", type: "d" } };
          if (path === "/api/block/getBlockDOM") {
            if (body.id === rootID) return { code: 0, data: { id: rootID, dom: multiDocDom } };
            return { code: 0, data: { id: body.id, dom: `<div data-node-id="${body.id}"><img src="assets/localized.png" /></div>` } };
          }
          return { code: 0, data: {} };
        },
      },
      references: {
        commitOccurrenceDetailed: async (_target, nextPath) => {
          commitCallIdx += 1;
          if (nextPath === "assets/localized.png" && commitCallIdx === 2) {
            return { status: "conflict", conflictReason: "path-mismatch" };
          }
          return { status: "replaced" };
        },
      },
      records: {
        upsert: async () => {},
        markOperation: async (orig, comp, status) => { partialMarkOps.push({ orig, comp, status }); },
      },
    };
    globalThis.DOMParser = class {
      parseFromString() {
        return {
          querySelector: () => null,
          querySelectorAll: selector => selector === "img" ? [makeImg(remoteURL), makeImg(remoteURL)] : [makeBlock(blkA), makeBlock(blkB)],
        };
      }
    };
    const partialSummary = await compressDocumentImages({}, context, scope, multiServices, { rootID, notebook: "nb-1" });
    assert.equal(partialSummary.conflicts, 1);
    assert.deepEqual(partialMarkOps[0], { orig: remoteURL, comp: "assets/localized.png", status: "incomplete" });
  } finally {
    globalThis.DOMParser = prevDOMParser;
    globalThis.document = prevDocument;
    globalThis.HTMLElement = prevHTMLElement;
  }
});

test("I-15 + I-04 + I-07: flushes all active matching editors, re-validates dirty blocks, and counts failed writes", async () => {
  const prevDOMParser = globalThis.DOMParser;
  const prevDocument = globalThis.document;
  try {
    const rootID = id(20);
    const otherRootID = id(21);
    const blockID = id(22);
    const flushOrder = [];
    const docDOM = `<div data-node-id="${rootID}"><div data-node-id="${blockID}"><img src="assets/a.png"/><img src="assets/b.png"/></div></div>`;
    let currentBlockDOM = `<div data-node-id="${blockID}"><img src="assets/a.png"/><img src="assets/b.png"/></div>`;

    const makeImg = initialSrc => {
      let src = initialSrc;
      return {
        closest: sel => sel === "[data-node-id]" ? makeBlock(currentBlockDOM) : null,
        hasAttribute: name => name === "src",
        getAttribute: name => name === "src" ? src : null,
        setAttribute: (name, value) => { if (name === "src") src = value; },
        get outerHTML() { return `<img src="${src}"/>`; },
      };
    };
    const makeBlock = html => {
      const srcs = [...html.matchAll(/src="([^"]+)"/g)].map(m => m[1]);
      const imgs = srcs.map(makeImg);
      return {
        getAttribute: name => name === "data-node-id" ? blockID : null,
        removeAttribute() {},
        querySelector: () => null,
        querySelectorAll: sel => sel === "img" ? imgs : [],
        get outerHTML() {
          return `<div data-node-id="${blockID}">${imgs.map(img => img.outerHTML).join("")}</div>`;
        },
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

    const { commitOneImageDetailed } = await import("../../../src/features/image-compressor/services/SafeBlockWriter.ts");
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
    const kernel = {
      post: async (path, body) => {
        if (path === "/api/block/getBlockInfo") return { code: 0, data: { id: body.id, rootID, box: "nb-1", type: body.id === rootID ? "d" : "p" } };
        if (path === "/api/block/getBlockDOM") {
          return { code: 0, data: { id: body.id, dom: body.id === rootID ? docDOM : currentBlockDOM } };
        }
        if (path === "/api/block/updateBlock") {
          // Simulate concurrent modification of the second image target in the same block after first commit
          currentBlockDOM = `<div data-node-id="${blockID}"><img src="assets/a.webp"/><img src="assets/changed.png"/></div>`;
          return { code: 0, data: null };
        }
        throw new Error(path);
      },
    };
    const services = {
      origin: "http://localhost:6806",
      mobile: true,
      config: () => defaultImageFeatureConfig(),
      kernel,
      compressOccurrence: async (target) => ({
        status: "saved",
        path: target.oldPath.includes("a.png") ? "assets/a.webp" : "assets/b.webp",
        reference: "not-requested",
        originalBytes: 100,
        compressedBytes: 50,
      }),
      references: {
        commitOccurrenceDetailed: (target, newPath, signal) =>
          commitOneImageDetailed(kernel, target, newPath, "http://localhost:6806", signal),
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

test("single block with 4 images (1 skipped, 3 replaced) commits all 3 across doc vs block data-node-index and updated mismatch", async () => {
  const prevDOMParser = globalThis.DOMParser;
  const prevDocument = globalThis.document;
  try {
    const rootID = id(30);
    const blockID = id(31);
    const makeBlockDOM = (paths, updated = "20261122005023", nodeIndex = "1") =>
      `<div data-node-id="${blockID}" data-node-index="${nodeIndex}" updated="${updated}">${paths.map(p => `<img src="${p}" data-src="${p}" />`).join("")}</div>`;
    let kernelBlockDOM = makeBlockDOM(["assets/1.png", "assets/2.png", "assets/3.png", "assets/4.png"], "20261122005023", "1");
    // Root doc getBlockDOM renders non-first blocks with higher data-node-index (e.g. 13)
    const docDOM = `<div data-node-id="${rootID}">${makeBlockDOM(["assets/1.png", "assets/2.png", "assets/3.png", "assets/4.png"], "20261122005023", "13")}</div>`;

    const parseImgs = html => [...html.matchAll(/<img\b([^>]*)>/g)].map(m => {
      const attrs = new Map([...m[1].matchAll(/([\w-]+)="([^"]*)"/g)].map(a => [a[1], a[2]]));
      return {
        tagName: "IMG",
        hasAttribute: name => attrs.has(name),
        getAttribute: name => attrs.get(name) ?? null,
        setAttribute: (name, value) => attrs.set(name, value),
        removeAttribute: name => attrs.delete(name),
        get outerHTML() {
          return `<img${[...attrs].map(([k, v]) => ` ${k}="${v}"`).join("")}>`;
        },
        closest: sel => sel === "[data-node-id]" ? wrapBlock(kernelBlockDOM) : null,
      };
    });
    const wrapBlock = (html, stripSelfClosing = false) => {
      const open = html.match(/<div\b([^>]*)>([\s\S]*)<\/div>$/);
      const rootAttrs = new Map([...(open?.[1] ?? "").matchAll(/([\w-]+)="([^"]*)"/g)].map(a => [a[1], a[2]]));
      const imgs = parseImgs(open?.[2] ?? html);
      return {
        getAttribute: name => rootAttrs.get(name) ?? null,
        removeAttribute: name => rootAttrs.delete(name),
        querySelector: () => null,
        querySelectorAll: sel => {
          if (sel === "img") return imgs;
          if (sel === "[updated]" || sel === "[parent-heading]") return [];
          return [];
        },
        get outerHTML() {
          const attrsStr = [...rootAttrs].map(([k, v]) => ` ${k}="${v}"`).join("");
          const body = imgs.map(img => stripSelfClosing ? img.outerHTML : img.outerHTML.replace(/>$/, " />")).join("");
          return `<div${attrsStr}>${body}</div>`;
        },
      };
    };

    // 模拟 DOMParser 将 Lute 自闭合 `<img ... />` 序列化为 `<img ...>`，且根节点与单块索引不同
    globalThis.DOMParser = class {
      parseFromString(html) {
        const inner = html.replace(/^<div[^>]*>/, "").replace(/<\/div>$/, "");
        const block = wrapBlock(inner, true);
        const imgs = block.querySelectorAll("img").map(img => ({
          ...img,
          closest: sel => sel === "[data-node-id]" ? block : null,
        }));
        return {
          querySelector: () => null,
          querySelectorAll: sel => sel === "img" ? imgs : sel === "[data-node-id]" ? [block] : [],
        };
      }
    };
    globalThis.document = {
      createElement: () => ({
        _html: "",
        set innerHTML(val) { this._html = val; },
        get content() {
          const block = wrapBlock(this._html, true);
          return { children: [block], querySelectorAll: () => [] };
        },
      }),
    };

    const { commitOneImageDetailed } = await import("../../../src/features/image-compressor/services/SafeBlockWriter.ts");
    const { compressDocumentImages } = await import("../../../src/features/image-compressor/actions/DocumentBatchAction.ts");

    const markOps = [];
    const debugLogs = [];
    const kernel = {
      post: async (path, body) => {
        if (path === "/api/block/getBlockInfo") return { code: 0, data: { id: body.id, rootID, box: "nb-1", type: body.id === rootID ? "d" : "p" } };
        if (path === "/api/block/getBlockDOM") {
          return { code: 0, data: { id: body.id, dom: body.id === rootID ? docDOM : kernelBlockDOM } };
        }
        if (path === "/api/block/updateBlock") {
          // Kernel re-serializes `<img ...>` back to self-closing `<img ... />` and bumps `updated`
          kernelBlockDOM = body.data.replace(/<img([^>]*?)>/g, "<img$1 />").replace(/updated="[^"]+"/, 'updated="20261122005999"');
          return { code: 0, data: null };
        }
        throw new Error(path);
      },
    };
    const services = {
      origin: "http://localhost:6806",
      mobile: true,
      config: () => defaultImageFeatureConfig(),
      kernel,
      compressOccurrence: async (target) => {
        if (target.oldPath.includes("4.png")) return { status: "skipped" };
        return {
          status: "saved",
          path: target.oldPath.replace(".png", ".webp"),
          reference: "not-requested",
          originalBytes: 200,
          compressedBytes: 100,
        };
      },
      references: {
        commitOccurrenceDetailed: (target, newPath, signal) =>
          commitOneImageDetailed(kernel, target, newPath, "http://localhost:6806", signal),
      },
      records: {
        markOperation: async (orig, comp, status) => { markOps.push({ orig, comp, status }); },
      },
    };

    const summary = await compressDocumentImages(
      {},
      { logger: { warn() {}, debug: (msg, data) => debugLogs.push({ msg, data }) } },
      { active: true, signal: new AbortController().signal },
      services,
      { rootID, notebook: "nb-1" },
    );

    assert.equal(summary.succeeded, 3);
    assert.equal(summary.skipped, 1);
    assert.equal(summary.conflicts, 0);
    assert.equal(summary.failed, 0);
    assert.deepEqual(markOps.map(m => m.status), ["replaced", "replaced", "replaced"]);
    assert.equal(debugLogs.some(l => l.data?.path === "assets/4.png"), true);
  } finally {
    globalThis.DOMParser = prevDOMParser;
    globalThis.document = prevDocument;
  }
});
