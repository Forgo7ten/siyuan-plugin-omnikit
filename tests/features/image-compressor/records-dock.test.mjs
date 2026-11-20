import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import {
  checkAssetAvailability,
  locateAssetOccurrences,
  reconcileRecordPair,
} from "../../../src/features/image-compressor/services/ImageReferences.ts";
import { ImageCompressionRecordStore } from "../../../src/features/image-compressor/store/ImageCompressionRecordStore.ts";

const dockPath = new URL("../../../src/features/image-compressor/ui/ImageRecordsDock.svelte", import.meta.url);
const refsPath = new URL("../../../src/features/image-compressor/services/ImageReferences.ts", import.meta.url);
const registrationPath = new URL("../../../src/features/image-compressor/registration.ts", import.meta.url);
const zhJsonPath = new URL("../../../src/i18n/zh-CN.json", import.meta.url);
const enJsonPath = new URL("../../../src/i18n/en.json", import.meta.url);

test("image records dock shares the feature record store and is registered as its dock view", async () => {
  const [dock, registration] = await Promise.all([
    readFile(dockPath, "utf8"),
    readFile(registrationPath, "utf8"),
  ]);

  assert.match(dock, /imageRecordsFor\(context\.plugin\)/);
  assert.match(registration, /import ImageRecordsDock from "\.\/ui\/ImageRecordsDock\.svelte"/);
  assert.match(registration, /dockView:\s*ImageRecordsDock/);
  assert.match(dock, /store\.snapshot\(\)/);
  assert.match(dock, /store\.store\.subscribe\(/);
  assert.match(dock, /store\.removeRecord\(record\.originalPath\)/);
});

test("dock lookups and availability checks enforce D01/D06/D12/I-05/P3-6/B-3/P3-7 contracts", async () => {
  const [dock, refs] = await Promise.all([
    readFile(dockPath, "utf8"),
    readFile(refsPath, "utf8"),
  ]);

  assert.match(dock, /onclick=\{\(\) => toggleOriginalReferences\(record\)\}/);
  assert.match(dock, /onclick=\{\(\) => locateRestoreOccurrences\(record\)\}/);
  assert.match(refs, /\/api\/asset\/findAssetReferences/);
  assert.match(refs, /\/api\/block\/getBlockDOMs/);
  assert.match(refs, /\/api\/block\/getBlockDOM/);
  assert.match(refs, /\/api\/asset\/statAsset/);
  assert.match(refs, /\/api\/file\/getFile/);
  assert.match(dock, /reconcileRecordPair/);
  assert.match(dock, /locateAssetOccurrences/);
  assert.match(dock, /image\.records\.imageRefs/);
  assert.match(dock, /image\.records\.linkRefs/);
  assert.match(dock, /image\.records\.unsupportedRefs/);
  assert.match(dock, /image\.records\.skippedNotebooks/);
  assert.match(dock, /image\.records\.incompleteLookup/);
  assert.match(dock, /image\.records\.copyManual/);
  assert.match(dock, /const nextOp: OperationKind = lastLocateComplete && occurrences\.length === 0 && conflicts === 0 \? resolvedOp : "incomplete"/);
  assert.match(dock, /store\.markOperation\(record\.originalPath, record\.compressedPath, nextOp\)/);
  assert.match(dock, /references\.commitOccurrence\(target, nextPath,\s*signal\)/);
  assert.match(dock, /openTab\(/);
  assert.match(dock, /jumpToBlock\(/);
  assert.match(dock, /navigator\.clipboard\?\.writeText/);
  assert.match(dock, /showManualCopyDialog/);
  assert.match(dock, /dockAbort\?\.abort\(\)/);
  assert.match(dock, /omnikit-dock-tab-activated/);
  assert.match(dock, /max-height:\s*56px/);
  assert.doesNotMatch(dock, /relinkAsset|\/api\/asset\/removeAsset|removeAsset\(/);
  assert.doesNotMatch(dock, /prunedNotice|noSafeOccurrences|MAX_RECORDS|CAPACITY_WARNING_COUNT|capacityBanner/);
  // No statusCache: every activation or refresh re-checks asset availability directly
  assert.match(dock, /onclick=\{\(\) => refresh\(\)\}/);
  assert.doesNotMatch(dock, /statusCache|STATUS_TTL_MS/);
  // P3-7: O(N) cleanup using nextPaths Set (no O(N^2) records.some inside key loop)
  assert.match(dock, /nextPaths\.has\(path\)/);
});

test("image records dock i18n defines contextual empty strings and omits obsolete negative text", async () => {
  const [zhRaw, enRaw] = await Promise.all([
    readFile(zhJsonPath, "utf8"),
    readFile(enJsonPath, "utf8"),
  ]);
  const zh = JSON.parse(zhRaw);
  const en = JSON.parse(enRaw);

  assert.equal(zh["image.records.noOriginalReferences"], "当前笔记中未找到原图引用");
  assert.equal(zh["image.records.noCompressedReferences"], "当前笔记中未找到压缩图引用");
  assert.equal(zh["image.records.noSafeOccurrences"], undefined);

  assert.equal(en["image.records.noOriginalReferences"], "No original references found in notes.");
  assert.equal(en["image.records.noCompressedReferences"], "No compressed references found in notes.");
  assert.equal(en["image.records.noSafeOccurrences"], undefined);
});

test("dock reference lookup distinguishes user_click and post_action, preserves action result, and auto-collapses on completion", async () => {
  const dock = await readFile(dockPath, "utf8");

  assert.match(dock, /async function locateOccurrences\(\s*record:\s*CompressionRecord,\s*mode:\s*"original"\s*\|\s*"compressed",\s*source:\s*"user_click"\s*\|\s*"post_action"\s*=\s*"user_click",?\s*\)/);
  assert.match(dock, /if\s*\(source === "user_click"\)\s*\{\s*message = "";\s*\}/);
  assert.match(dock, /if\s*\(!signal\?\.aborted && !isAbortError\(error\) && source === "user_click"\)/);
  assert.match(dock, /if\s*\(!located\.items\.length && !located\.unsupported\.length\)\s*\{\s*expanded = null;\s*occurrences = \[\];\s*unsupportedRefs = \[\];\s*\}/);
  assert.match(dock, /applyOccurrenceAction\(record, expanded\.mode, \[item\]\)/);
  assert.match(dock, /applyOccurrenceAction\(record, expanded\.mode, occurrences\)/);
});

test("image records dock renders Option A brand hero card buffer and i18n hero titles", async () => {
  const [dock, zhRaw, enRaw] = await Promise.all([
    readFile(dockPath, "utf8"),
    readFile(zhJsonPath, "utf8"),
    readFile(enJsonPath, "utf8"),
  ]);
  const zh = JSON.parse(zhRaw);
  const en = JSON.parse(enRaw);

  assert.match(dock, /class="image-records__hero"/);
  assert.match(dock, /class="image-records__hero-title"/);
  assert.match(dock, /class="image-records__hero-subtitle"/);
  assert.match(dock, /t\("dock\.heroTitle"\)/);
  assert.match(dock, /t\("dock\.heroSubtitle"\)/);

  assert.equal(zh["dock.heroTitle"], "OmniKit / 图片记录");
  assert.equal(zh["dock.heroSubtitle"], "图片资产管理与无损追溯");
  assert.equal(en["dock.heroTitle"], "OmniKit / Image Records");
  assert.equal(en["dock.heroSubtitle"], "Asset Management & Traceability");
});

test("D01: checkAssetAvailability treats statAsset code=1 and transport errors as unknown, never removing records on code=1", async () => {
  const storage = new Map();
  const plugin = {
    async loadData(p) { return storage.has(p) ? structuredClone(storage.get(p)) : ""; },
    async saveData(p, d) { storage.set(p, structuredClone(d)); },
  };
  const store = new ImageCompressionRecordStore(plugin);
  await store.init();
  await store.upsert("assets/a.png", "assets/a.webp");
  await store.upsert("assets/a.webp", "assets/a2.webp");

  const deferredKernel = {
    async post() { return { code: 0, data: { downloaded: false, size: 123 } }; },
  };
  assert.equal(await checkAssetAvailability(deferredKernel, "assets/a.png"), "present");

  const code1Kernel = {
    async post() { throw Object.assign(new Error("stat failed"), { code: 1 }); },
  };
  assert.equal(await checkAssetAvailability(code1Kernel, "assets/a.png", undefined, {
    fetchFn: async () => new Response(JSON.stringify({ code: 500, msg: "io error" }), { status: 500 }),
  }), "unknown");

  assert.equal(await checkAssetAvailability(code1Kernel, "assets/a.png", undefined, {
    fetchFn: async () => new Response("binary", { status: 200 }),
  }), "present");

  assert.equal(await checkAssetAvailability(code1Kernel, "assets/a.png?box=20260101000001-abcdef0", undefined, {
    fetchFn: async () => { throw new Error("Must not call getFile for ?box="); },
  }), "unknown");

  const timeoutKernel = {
    async post() { throw new Error("Request timed out"); },
  };
  assert.equal(await checkAssetAvailability(timeoutKernel, "assets/a.png"), "unknown");

  // Reconcile under code=1 + getFile non-404 -> unknown: MUST preserve ALL records
  const recA = store.snapshot().find(r => r.originalPath === "assets/a.png");
  const resUnknown = await reconcileRecordPair(
    recA,
    p => checkAssetAvailability(code1Kernel, p, undefined, {
      fetchFn: async () => new Response(JSON.stringify({ code: 500 }), { status: 202 }),
    }),
    store,
  );
  assert.equal(resUnknown.original, "unknown");
  assert.equal(resUnknown.removed, false);
  assert.equal(store.snapshot().length, 2);

  // Reconcile when compressed is proven missing-confirmed via statAsset code=1 + getFile 202/404: removes ONLY that single pair, no cascade
  const resConfirmed = await reconcileRecordPair(
    recA,
    p => checkAssetAvailability(code1Kernel, p, undefined, {
      fetchFn: async (_url, init) => {
        const { path } = JSON.parse(init.body);
        if (path === "data/assets/a.webp") {
          return new Response(JSON.stringify({ code: 404, msg: "not found" }), { status: 202 });
        }
        return new Response("binary", { status: 200 });
      },
    }),
    store,
  );
  assert.equal(resConfirmed.original, "present");
  assert.equal(resConfirmed.compressed, "missing-confirmed");
  assert.equal(resConfirmed.removed, true);
  assert.deepEqual(store.snapshot().map(r => r.originalPath), ["assets/a.webp"]);
});

test("D06: locateAssetOccurrences finds grouped images, resource links, and unsupported AV references", async () => {
  const rootID = "20260101000000-abcdef0";
  const boxID = "20260101000001-abcdef0";
  const blockID = "20260101000002-abcdef0";
  const dom = `<div data-node-id="${blockID}"><img data-src="assets/a.png" src="assets/a.png"><span data-type="a" data-href="assets/a.png">link1</span><a href="assets/a.png">link2</a></div>`;

  const priorDoc = globalThis.document;
  const makeNode = (tag, attrs, text = "") => ({
    tagName: tag.toUpperCase(),
    textContent: text,
    hasAttribute: n => n in attrs,
    getAttribute: n => attrs[n] ?? null,
    closest: () => null,
  });
  const imgEl = makeNode("img", { "data-src": "assets/a.png", src: "assets/a.png" });
  const spanEl = makeNode("span", { "data-type": "a", "data-href": "assets/a.png" }, "link1");
  const anchorEl = makeNode("a", { href: "assets/a.png" }, "link2");
  const blockNode = {
    getAttribute: n => (n === "data-node-id" ? blockID : null),
    querySelector: () => null,
    querySelectorAll: sel => {
      if (sel === "img") return [imgEl];
      if (sel === "a[href], span[data-href]") return [spanEl, anchorEl];
      return [];
    },
  };
  globalThis.document = {
    createElement: () => ({
      content: { children: [blockNode], querySelectorAll: () => [] },
      set innerHTML(_) {},
    }),
  };

  try {
    const kernel = {
      async post(url) {
        if (url === "/api/asset/findAssetReferences") {
          return {
            code: 0,
            data: {
              references: [
                { type: "block", rootID, notebook: boxID, blockID, relinkable: true, reference: "assets/a.png" },
                { type: "attribute-view", rootID, notebook: boxID, relinkable: false, reason: "AV cell", reference: "assets/a.png" },
              ],
              skippedNotebooks: [],
              unavailableAttributeViews: [],
            },
          };
        }
        if (url === "/api/block/getBlockDOMs") {
          return { code: 0, data: { [blockID]: dom } };
        }
        if (url === "/api/filetree/getFullHPathByID") {
          return { code: 0, data: "/Test Doc" };
        }
        throw new Error(url);
      },
    };

    const result = await locateAssetOccurrences(kernel, "http://localhost:6806", "assets/a.png", k => k);
    assert.equal(result.ok, true);
    assert.equal(result.items.length, 3);
    assert.equal(result.items.filter(i => i.target.kind === "image").length, 1);
    assert.equal(result.items.filter(i => i.target.kind === "link").length, 2);
    assert.equal(result.unsupported.length, 1);
  } finally {
    globalThis.document = priorDoc;
  }
});

test("D12: ?box= lookup skips global findAssetReferences, scans unlocked notebook APIs, and reports locked notebooks as unavailable", async () => {
  const boxID = "20260101000001-abcdef0";
  const docID = "20260101000000-abcdef0";
  const blockID = "20260101000002-abcdef0";
  const searchPath = `assets/enc.png?box=${boxID}`;
  const docDOM = `<div data-node-id="${docID}"><div data-node-id="${blockID}"><img data-src="${searchPath}" src="${searchPath}"></div></div>`;
  const blockDOMStr = `<div data-node-id="${blockID}"><img data-src="${searchPath}" src="${searchPath}"></div>`;

  const priorDoc = globalThis.document;
  const imgNode = {
    hasAttribute: n => n === "data-src" || n === "src",
    getAttribute: n => (n === "data-src" || n === "src" ? searchPath : null),
    closest: sel => (sel === "[data-node-id]" ? { getAttribute: () => blockID, querySelector: () => null } : null),
  };
  const blockRoot = {
    getAttribute: n => (n === "data-node-id" ? blockID : null),
    querySelector: () => null,
    querySelectorAll: sel => (sel === "img" ? [imgNode] : []),
  };
  globalThis.document = {
    createElement: () => {
      let currentHtml = "";
      return {
        content: {
          get children() { return currentHtml === blockDOMStr ? [blockRoot] : []; },
          querySelectorAll: sel => (sel === "img" ? [imgNode] : []),
        },
        set innerHTML(v) { currentHtml = v; },
      };
    },
  };

  try {
    let globalCalled = false;
    const unlockedKernel = {
      async post(url, body) {
        if (url === "/api/asset/findAssetReferences") {
          globalCalled = true;
          throw new Error("Must not call findAssetReferences for ?box=");
        }
        if (url === "/api/notebook/lsNotebooks") {
          return { code: 0, data: { notebooks: [{ id: boxID, closed: false, name: "Secret" }] } };
        }
        if (url === "/api/filetree/listDocsByPath") {
          assert.equal(body.notebook, boxID);
          return { code: 0, data: { files: [{ id: docID, path: `/${docID}.sy`, name: "Note", subFileCount: 0 }] } };
        }
        if (url === "/api/block/getBlockDOMs") {
          assert.equal(body.notebook, boxID);
          if (body.ids.includes(docID)) return { code: 0, data: { [docID]: docDOM } };
          if (body.ids.includes(blockID)) return { code: 0, data: { [blockID]: blockDOMStr } };
        }
        if (url === "/api/filetree/getFullHPathByID") {
          return { code: 0, data: "/Secret/Note" };
        }
        throw new Error(url);
      },
    };

    const unlockedResult = await locateAssetOccurrences(unlockedKernel, "http://localhost:6806", searchPath, k => k);
    assert.equal(globalCalled, false);
    assert.equal(unlockedResult.ok, true);
    assert.equal(unlockedResult.encryptedUnavailable, false);
    assert.equal(unlockedResult.items.length, 1);
    assert.equal(unlockedResult.items[0].target.oldPath, searchPath);

    // Locked / closed notebook must report encryptedUnavailable: true (never "no references")
    const lockedKernel = {
      async post(url) {
        if (url === "/api/notebook/lsNotebooks") {
          return { code: 0, data: { notebooks: [{ id: boxID, closed: true, name: "Secret" }] } };
        }
        throw new Error(url);
      },
    };
    const lockedResult = await locateAssetOccurrences(lockedKernel, "http://localhost:6806", searchPath, k => k);
    assert.equal(lockedResult.ok, false);
    assert.equal(lockedResult.encryptedUnavailable, true);
    assert.equal(lockedResult.items.length, 0);
  } finally {
    globalThis.document = priorDoc;
  }
});
