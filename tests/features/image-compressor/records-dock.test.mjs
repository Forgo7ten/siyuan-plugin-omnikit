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
const cardPath = new URL("../../../src/features/image-compressor/ui/ImageRecordCard.svelte", import.meta.url);
const recordRefsPath = new URL("../../../src/features/image-compressor/ui/ImageRecordReferences.svelte", import.meta.url);
const refsPath = new URL("../../../src/features/image-compressor/services/ImageReferences.ts", import.meta.url);
const assetAvailPath = new URL("../../../src/features/image-compressor/services/assetAvailability.ts", import.meta.url);
const boxLocatorPath = new URL("../../../src/features/image-compressor/services/boxReferenceLocator.ts", import.meta.url);
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
  const [dock, card, recordRefs, refs, assetAvail, boxLocator] = await Promise.all([
    readFile(dockPath, "utf8"),
    readFile(cardPath, "utf8"),
    readFile(recordRefsPath, "utf8"),
    readFile(refsPath, "utf8"),
    readFile(assetAvailPath, "utf8"),
    readFile(boxLocatorPath, "utf8"),
  ]);
  const dockUI = [dock, card, recordRefs].join("\n");
  const refsAll = [refs, assetAvail, boxLocator].join("\n");

  assert.match(card, /onclick=\{\(\) => onToggleOriginalReferences\(record\)\}/);
  assert.match(card, /onclick=\{\(\) => onLocateRestoreOccurrences\(record\)\}/);
  assert.match(dock, /onToggleOriginalReferences=\{rec => toggleOriginalReferences\(rec\)\}/);
  assert.match(dock, /onLocateRestoreOccurrences=\{rec => locateRestoreOccurrences\(rec\)\}/);
  assert.match(refsAll, /\/api\/asset\/findAssetReferences/);
  assert.match(refsAll, /\/api\/block\/getBlockDOMs/);
  assert.match(refsAll, /\/api\/block\/getBlockDOM/);
  assert.match(refsAll, /\/api\/asset\/statAsset/);
  assert.match(refsAll, /\/api\/file\/getFile/);
  assert.match(dock, /reconcileRecordPair/);
  assert.match(dock, /locateAssetOccurrences/);
  assert.match(dockUI, /image\.records\.imageRefs/);
  assert.match(dockUI, /image\.records\.linkRefs/);
  assert.match(dockUI, /image\.records\.unsupportedRefs/);
  assert.match(dock, /image\.records\.skippedNotebooks/);
  assert.match(dock, /image\.records\.incompleteLookup/);
  assert.match(dock, /image\.records\.copyManual/);
  assert.match(dock, /openCopyablePathDialog/);
  assert.match(dock, /const nextOp: OperationKind = lastLocateComplete && occurrences\.length === 0 && conflicts === 0 \? resolvedOp : "incomplete"/);
  assert.match(dock, /store\.markOperation\(record\.originalPath, record\.compressedPath, nextOp\)/);
  assert.match(dock, /references\.commitOccurrence\(target, nextPath,\s*signal\)/);
  assert.match(dock, /openTab\(/);
  assert.match(dock, /jumpToBlock\(/);
  assert.match(dock, /context\.feedback\.copyable\(/);
  assert.doesNotMatch(dockUI, /\bshowMessage\b/);
  assert.match(dock, /showManualCopyDialog/);
  assert.match(dock, /dockAbort\?\.abort\(\)/);
  assert.match(dock, /omnikit-dock-tab-activated/);
  assert.match(dock, /max-height:\s*56px/);
  assert.doesNotMatch(dockUI, /relinkAsset|\/api\/asset\/removeAsset|removeAsset\(/);
  assert.doesNotMatch(dockUI, /prunedNotice|noSafeOccurrences|MAX_RECORDS|CAPACITY_WARNING_COUNT|capacityBanner/);
  // No statusCache: every activation or refresh re-checks asset availability directly
  assert.match(dock, /onclick=\{\(\) => refresh\(\)\}/);
  assert.doesNotMatch(dockUI, /statusCache|STATUS_TTL_MS/);
  // P3-7: O(N) cleanup using nextPaths Set (no O(N^2) records.some inside key loop)
  assert.match(dock, /nextPaths\.has\(path\)/);
  // Phase 0 problem 2 contracts: single-pass cold start, per-record abort & stale pair guard, depth-counted busy lock
  assert.match(dock, /let initialized = false;/);
  assert.match(dock, /let busyDepth = \$state\(0\);/);
  assert.match(dock, /async function withBusy</);
  assert.match(dock, /const recordControllers = new Map<string, AbortController>\(\);/);
  assert.match(dock, /function isCurrentPair\(/);
  assert.match(dock, /if \(!busy && !loading\) void refresh\(\);/);
  assert.match(dock, /checkAssetAvailability\(kernel, nextPath, signal, \{ origin \}\)/);
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
  const [dock, recordRefs] = await Promise.all([
    readFile(dockPath, "utf8"),
    readFile(recordRefsPath, "utf8"),
  ]);

  assert.match(dock, /async function locateOccurrences\(\s*record:\s*CompressionRecord,\s*mode:\s*"original"\s*\|\s*"compressed",\s*source:\s*"user_click"\s*\|\s*"post_action"\s*=\s*"user_click",?\s*\)/);
  assert.match(dock, /if\s*\(source === "user_click"\)\s*\{\s*message = "";\s*\}/);
  assert.match(dock, /if\s*\(!signal\?\.aborted && !isAbortError\(error\) && source === "user_click"\)/);
  assert.match(dock, /if\s*\(!located\.items\.length && !located\.unsupported\.length\)\s*\{\s*expanded = null;\s*occurrences = \[\];\s*unsupportedRefs = \[\];\s*\}/);
  assert.match(dock, /onApplyOccurrenceAction=\{\(rec, mode, items\) => applyOccurrenceAction\(rec, mode, items\)\}/);
  assert.match(recordRefs, /onApplyOccurrenceAction\(record, mode, \[item\]\)/);
  assert.match(recordRefs, /onApplyOccurrenceAction\(record, mode, occurrences\)/);
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

test("D01: checkAssetAvailability treats statAsset code=1 and transport errors as unknown, never removing records on code=1", async () => {
  const storage = new Map();
  let loadDataCalls = 0;
  const plugin = {
    async loadData(p) { loadDataCalls += 1; return storage.has(p) ? structuredClone(storage.get(p)) : ""; },
    async saveData(p, d) { storage.set(p, structuredClone(d)); },
  };
  const store = new ImageCompressionRecordStore(plugin, { fetchFn: createFileGetFetch(storage) });
  await store.init();
  assert.equal(loadDataCalls, 0);
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

test("ImageRecordsDock runtime avoids cold-start double verify, prevents stale pair overwrite, and holds busy across post_action sync", async () => {
  const { stripTypeScriptTypes } = await import("node:module");
  const svelte = await readFile(dockPath, "utf8");
  const scriptMatch = svelte.match(/<script lang="ts">([\s\S]*?)<\/script>/);
  assert.ok(scriptMatch, "expected script block");

  const stripped = stripTypeScriptTypes(
    scriptMatch[1]
      .replace(/^\s*import[\s\S]*?from\s+["'][^"']+["'];\s*$/gm, "")
      .replace(/let\s*\{\s*context,\s*t\s*\}:\s*Props\s*=\s*\$props\(\);/, "let { context, t } = __harness.props;")
      .replace(/let busy = \$derived\(busyDepth > 0\);/, "const getBusy = () => busyDepth > 0; let busy = false;")
      .replace(/let imageItems = \$derived\([^;]+\);/, "")
      .replace(/let linkItems = \$derived\([^;]+\);/, "")
      .replace(/if \(!busy && !loading\)/g, "if (!getBusy() && !loading)")
  );

  const factory = new Function(
    "__harness",
    `
    const $state = v => v;
    const {
      onMount, untrack, Dialog, openTab, isAbortError, KernelClient,
      imageRecordsFor, blockDOM, ReferenceService, checkAssetAvailability,
      locateAssetOccurrences, reconcileRecordPair, resolveImageOccurrence,
      findLinkCandidates, sameSource, trySource, isRemoteRecordSource,
    } = __harness;
    const openCopyablePathDialog = __harness.openCopyablePathDialog ?? ((scope, options) => {
      if (!scope.active) return undefined;
      let closed = false;
      const dialog = new Dialog(options);
      const release = scope.own(() => { if (!closed) { closed = true; dialog.destroy?.(); } });
      return { close: () => { if (!closed) { closed = true; dialog.destroy?.(); release(); } } };
    });
    ${stripped}
    return {
      getState: () => ({ records, assetStatuses, busy: getBusy(), busyDepth, loading, initialized, message }),
      refresh,
      locateOccurrences,
      locateRestoreOccurrences,
      applyOccurrenceAction,
      removeRecord,
      copyPath,
    };
    `,
  );

  const prevWindow = globalThis.window;
  const winListeners = new Map();
  globalThis.window = {
    addEventListener(name, fn) {
      if (!winListeners.has(name)) winListeners.set(name, new Set());
      winListeners.get(name).add(fn);
    },
    removeEventListener(name, fn) {
      winListeners.get(name)?.delete(fn);
    },
    dispatchEvent(name) {
      for (const fn of winListeners.get(name) ?? []) fn();
    },
  };

  try {
    // 1. Cold start: store emits during `await ready` -> must NOT run two full verifyRecords passes
    {
      let currentRecords = [];
      const subs = new Set();
      let resolveReady;
      const ready = new Promise(r => { resolveReady = r; });
      const emit = next => {
        currentRecords = next;
        for (const fn of subs) fn({ records: currentRecords });
      };
      const store = {
        store: {
          subscribe(fn) {
            subs.add(fn);
            fn({ records: currentRecords });
            return () => subs.delete(fn);
          },
        },
        snapshot: () => currentRecords,
        markOperation: async () => {},
        removeRecord: async () => {},
      };

      const verifiedPairs = [];
      let mountCleanup;
      const dock = factory({
        props: { context: { plugin: {}, logger: { debug() {}, warn() {} }, feedback: { notify() {}, copyable: async () => true } }, t: k => k },
        onMount: fn => { mountCleanup = fn(); },
        untrack: fn => fn(),
        Dialog: class {},
        openTab: () => {},
        isAbortError: e => e?.name === "AbortError",
        KernelClient: class {},
        imageRecordsFor: () => ({ store, ready }),
        blockDOM: async () => "",
        ReferenceService: class { async commitOccurrence() { return "replaced"; } },
        checkAssetAvailability: async () => "present",
        locateAssetOccurrences: async () => ({ ok: true, complete: true, items: [], unsupported: [], skippedNotebooks: [], unavailableAttributeViews: 0, metadataIncomplete: false, encryptedUnavailable: false }),
        reconcileRecordPair: async (record) => {
          verifiedPairs.push(`${record.originalPath}->${record.compressedPath}`);
          return { original: "present", compressed: "present", removed: false };
        },
        resolveImageOccurrence: () => undefined,
        findLinkCandidates: () => [],
        sameSource: (a, b) => a === b,
        trySource: () => null,
        isRemoteRecordSource: p => typeof p === "string" && /^https?:\/\//i.test(p.trim()),
      });

      // Simulate JsonStore.readIntoMemory() emitting while refresh() is awaiting ready
      emit([{ originalPath: "assets/a.png", compressedPath: "assets/a.webp", updatedAt: 1, lastOperation: "replaced" }]);
      assert.deepEqual(verifiedPairs, [], "must not verify via subscribe before initial refresh completes ready");
      resolveReady();
      await new Promise(r => setTimeout(r, 20));
      assert.deepEqual(verifiedPairs, ["assets/a.png->assets/a.webp"], "cold start must verify each record only once");
      assert.equal(dock.getState().initialized, true);
      mountCleanup?.();
    }

    // 2. Concurrent pair update A->B replaced by A->C: old A->B is aborted and late resolution cannot overwrite A->C or resurrect B
    {
      let currentRecords = [{ originalPath: "assets/a.png", compressedPath: "assets/b.webp", updatedAt: 1, lastOperation: "replaced" }];
      const subs = new Set();
      const emit = next => {
        currentRecords = next;
        for (const fn of subs) fn({ records: currentRecords });
      };
      const store = {
        store: {
          subscribe(fn) {
            subs.add(fn);
            fn({ records: currentRecords });
            return () => subs.delete(fn);
          },
        },
        snapshot: () => currentRecords,
        markOperation: async () => {},
        removeRecord: async () => {},
      };

      const signals = new Map();
      const resolvers = new Map();
      let mountCleanup;
      const dock = factory({
        props: { context: { plugin: {}, logger: { debug() {}, warn() {} }, feedback: { notify() {}, copyable: async () => true } }, t: k => k },
        onMount: fn => { mountCleanup = fn(); },
        untrack: fn => fn(),
        Dialog: class {},
        openTab: () => {},
        isAbortError: e => e?.name === "AbortError",
        KernelClient: class {},
        imageRecordsFor: () => ({ store, ready: Promise.resolve() }),
        blockDOM: async () => "",
        ReferenceService: class { async commitOccurrence() { return "replaced"; } },
        checkAssetAvailability: async () => "present",
        locateAssetOccurrences: async () => ({ ok: true, complete: true, items: [], unsupported: [], skippedNotebooks: [], unavailableAttributeViews: 0, metadataIncomplete: false, encryptedUnavailable: false }),
        reconcileRecordPair: (record, _check, _store, signal) => new Promise(resolve => {
          const key = `${record.originalPath}->${record.compressedPath}`;
          signals.set(key, signal);
          resolvers.set(key, resolve);
        }),
        resolveImageOccurrence: () => undefined,
        findLinkCandidates: () => [],
        sameSource: (a, b) => a === b,
        trySource: () => null,
        isRemoteRecordSource: p => typeof p === "string" && /^https?:\/\//i.test(p.trim()),
      });

      await new Promise(r => setTimeout(r, 10));
      assert.ok(signals.has("assets/a.png->assets/b.webp"));
      assert.equal(signals.get("assets/a.png->assets/b.webp").aborted, false);

      // Update pair to A->C while A->B is still in flight
      emit([{ originalPath: "assets/a.png", compressedPath: "assets/c.webp", updatedAt: 2, lastOperation: "replaced" }]);
      await new Promise(r => setTimeout(r, 10));
      assert.equal(signals.get("assets/a.png->assets/b.webp").aborted, true, "old pair verification must be aborted on pair change");
      assert.ok(signals.has("assets/a.png->assets/c.webp"));

      // Resolve new pair A->C first, then resolve stale A->B with conflicting status
      resolvers.get("assets/a.png->assets/c.webp")({ original: "present", compressed: "present", removed: false });
      await new Promise(r => setTimeout(r, 10));
      resolvers.get("assets/a.png->assets/b.webp")({ original: "unknown", compressed: "unknown", removed: false });
      await new Promise(r => setTimeout(r, 10));

      const statuses = dock.getState().assetStatuses;
      assert.equal(statuses["assets/a.png"], "present");
      assert.equal(statuses["assets/c.webp"], "present");
      assert.equal("assets/b.webp" in statuses, false, "stale compressed path B must not be resurrected");
      mountCleanup?.();
    }

    // 3. withBusy stays true after post_action locateOccurrences until syncOperationAfterAction finishes
    {
      const rec = { originalPath: "assets/a.png", compressedPath: "assets/a.webp", updatedAt: 1, lastOperation: "saved-only" };
      const subs = new Set();
      let busyDuringMarkOperation = false;
      let releaseMark;
      const markGate = new Promise(r => { releaseMark = r; });
      let verifyCount = 0;

      const store = {
        store: {
          subscribe(fn) {
            subs.add(fn);
            fn({ records: [rec] });
            return () => subs.delete(fn);
          },
        },
        snapshot: () => [rec],
        async markOperation() {
          busyDuringMarkOperation = dock.getState().busy;
          // Fire tab-activated event during syncOperationAfterAction; must NOT trigger refresh()
          globalThis.window.dispatchEvent("omnikit-dock-tab-activated");
          await markGate;
        },
        removeRecord: async () => {},
      };

      let mountCleanup;
      const dock = factory({
        props: { context: { plugin: {}, logger: { debug() {}, warn() {} }, feedback: { notify() {}, copyable: async () => true } }, t: k => k },
        onMount: fn => { mountCleanup = fn(); },
        untrack: fn => fn(),
        Dialog: class {},
        openTab: () => {},
        isAbortError: e => e?.name === "AbortError",
        KernelClient: class {},
        imageRecordsFor: () => ({ store, ready: Promise.resolve() }),
        blockDOM: async () => "",
        ReferenceService: class { async commitOccurrence() { return "replaced"; } },
        checkAssetAvailability: async () => "present",
        locateAssetOccurrences: async () => ({
          ok: true,
          complete: true,
          items: [],
          unsupported: [],
          skippedNotebooks: [],
          unavailableAttributeViews: 0,
          metadataIncomplete: false,
          encryptedUnavailable: false,
        }),
        reconcileRecordPair: async () => {
          verifyCount += 1;
          return { original: "present", compressed: "present", removed: false };
        },
        resolveImageOccurrence: () => undefined,
        findLinkCandidates: () => [],
        sameSource: (a, b) => a === b,
        trySource: () => null,
        isRemoteRecordSource: p => typeof p === "string" && /^https?:\/\//i.test(p.trim()),
      });

      await new Promise(r => setTimeout(r, 20));
      assert.equal(verifyCount, 1);

      const actionPromise = dock.applyOccurrenceAction(rec, "original", [{
        key: "k1",
        label: "Doc",
        target: { rootID: "r1", notebook: "b1", blockID: "blk1", imageOrdinal: 0, oldPath: "assets/a.png" },
      }]);
      await new Promise(r => setTimeout(r, 20));
      assert.equal(busyDuringMarkOperation, true, "busy must stay true after post_action locateOccurrences while syncing operation");
      assert.equal(dock.getState().busy, true);
      assert.equal(verifyCount, 1, "tab activation while busy must not trigger refresh()");

      releaseMark();
      await actionPromise;
      assert.equal(dock.getState().busy, false);
      assert.equal(dock.getState().busyDepth, 0);
      mountCleanup?.();
    }

    // 4. compareAndRemove synchronously notifies store.subscribe (which aborts itemAbort), yet result.removed branch still runs
    {
      let currentRecords = [{ originalPath: "assets/gone.png", compressedPath: "assets/gone.webp", updatedAt: 1, lastOperation: "replaced" }];
      const subs = new Set();
      const debugLogs = [];
      const emit = next => {
        currentRecords = next;
        for (const fn of subs) fn({ records: currentRecords });
      };
      const store = {
        store: {
          subscribe(fn) {
            subs.add(fn);
            fn({ records: currentRecords });
            return () => subs.delete(fn);
          },
        },
        snapshot: () => currentRecords,
        markOperation: async () => {},
        removeRecord: async () => {},
      };

      let mountCleanup;
      const dock = factory({
        props: { context: { plugin: {}, logger: { debug(msg, meta) { debugLogs.push({ msg, meta }); }, warn() {} }, feedback: { notify() {} } }, t: k => k },
        onMount: fn => { mountCleanup = fn(); },
        untrack: fn => fn(),
        Dialog: class {},
        openTab: () => {},
        isAbortError: e => e?.name === "AbortError",
        KernelClient: class {},
        imageRecordsFor: () => ({ store, ready: Promise.resolve() }),
        blockDOM: async () => "",
        ReferenceService: class { async commitOccurrence() { return "replaced"; } },
        checkAssetAvailability: async () => "missing",
        locateAssetOccurrences: async () => ({ ok: true, complete: true, items: [], unsupported: [], skippedNotebooks: [], unavailableAttributeViews: 0, metadataIncomplete: false, encryptedUnavailable: false }),
        reconcileRecordPair: async (_record, _check, _store, signal) => {
          emit([]);
          assert.equal(signal.aborted, true, "subscribe must cancel itemAbort when record is removed");
          return { original: "missing", compressed: "present", removed: true };
        },
        resolveImageOccurrence: () => undefined,
        findLinkCandidates: () => [],
        sameSource: (a, b) => a === b,
        trySource: () => null,
        isRemoteRecordSource: p => typeof p === "string" && /^https?:\/\//i.test(p.trim()),
      });

      await new Promise(r => setTimeout(r, 20));
      assert.ok(
        debugLogs.some(entry => entry.meta?.originalPath === "assets/gone.png"),
        "result.removed debug branch must run even though subscribe aborted itemAbort",
      );
      assert.deepEqual(dock.getState().assetStatuses, {});
      mountCleanup?.();
    }

    // 5. copyPath delegates to context.feedback.copyable and falls back to manual copy dialog on failure
    {
      const copyCalls = [];
      let copyResult = true;
      let dialogOpened = 0;
      let dialogDestroyed = 0;
      const store = {
        store: { subscribe(fn) { fn({ records: [] }); return () => {}; } },
        snapshot: () => [],
        markOperation: async () => {},
        removeRecord: async () => {},
      };
      let mountCleanup;
      const dock = factory({
        props: {
          context: {
            plugin: {},
            logger: { debug() {}, warn() {} },
            feedback: {
              notify() {},
              async copyable(text, notice) {
                copyCalls.push({ text, notice });
                return copyResult;
              },
            },
          },
          t: k => k,
        },
        onMount: fn => { mountCleanup = fn(); },
        untrack: fn => fn(),
        Dialog: class {
          constructor() {
            dialogOpened += 1;
            this.element = { querySelector: () => null };
          }
          destroy() {
            dialogDestroyed += 1;
          }
        },
        openTab: () => {},
        isAbortError: e => e?.name === "AbortError",
        KernelClient: class {},
        imageRecordsFor: () => ({ store, ready: Promise.resolve() }),
        blockDOM: async () => "",
        ReferenceService: class {},
        checkAssetAvailability: async () => "present",
        locateAssetOccurrences: async () => ({ ok: true, complete: true, items: [], unsupported: [], skippedNotebooks: [], unavailableAttributeViews: 0, metadataIncomplete: false, encryptedUnavailable: false }),
        reconcileRecordPair: async () => ({ original: "present", compressed: "present", removed: false }),
        resolveImageOccurrence: () => undefined,
        findLinkCandidates: () => [],
        sameSource: (a, b) => a === b,
        trySource: () => null,
        isRemoteRecordSource: p => typeof p === "string" && /^https?:\/\//i.test(p.trim()),
      });

      await dock.copyPath("assets/ok.png");
      assert.deepEqual(copyCalls, [{ text: "assets/ok.png", notice: "image.records.copied" }]);
      assert.equal(dock.getState().message, "image.records.copied");
      assert.equal(dialogOpened, 0);

      copyResult = false;
      await dock.copyPath("assets/fail.png");
      assert.equal(dock.getState().message, "image.records.copyFailed");
      assert.equal(dialogOpened, 1);
      assert.equal(dialogDestroyed, 0);
      mountCleanup?.();
      assert.equal(dialogDestroyed, 1, "D-BUG-05: unmounting ImageRecordsDock must auto-destroy open manual copy dialog");
    }

    // 6. applyOccurrenceAction appends image.records.resultConflicts only when conflicts > 0
    {
      const rec = { originalPath: "assets/a.png", compressedPath: "assets/a.webp", updatedAt: 1, lastOperation: "saved-only" };
      const subs = new Set();
      let commitOutcome = "replaced";
      const notifications = [];
      const store = {
        store: {
          subscribe(fn) {
            subs.add(fn);
            fn({ records: [rec] });
            return () => subs.delete(fn);
          },
        },
        snapshot: () => [rec],
        markOperation: async () => {},
        removeRecord: async () => {},
      };
      let mountCleanup;
      const dock = factory({
        props: {
          context: {
            plugin: {},
            logger: { debug() {}, warn() {} },
            feedback: {
              notify(text) { notifications.push(text); },
              copyable: async () => true,
            },
          },
          t: (key, values) => values ? `${key}:${JSON.stringify(values)}` : key,
        },
        onMount: fn => { mountCleanup = fn(); },
        untrack: fn => fn(),
        Dialog: class {},
        openTab: () => {},
        isAbortError: e => e?.name === "AbortError",
        KernelClient: class {},
        imageRecordsFor: () => ({ store, ready: Promise.resolve() }),
        blockDOM: async () => "",
        ReferenceService: class { async commitOccurrence() { return commitOutcome; } },
        checkAssetAvailability: async () => "present",
        locateAssetOccurrences: async () => ({
          ok: true,
          complete: true,
          items: [],
          unsupported: [],
          skippedNotebooks: [],
          unavailableAttributeViews: 0,
          metadataIncomplete: false,
          encryptedUnavailable: false,
        }),
        reconcileRecordPair: async () => ({ original: "present", compressed: "present", removed: false }),
        resolveImageOccurrence: () => undefined,
        findLinkCandidates: () => [],
        sameSource: (a, b) => a === b,
        trySource: () => null,
        isRemoteRecordSource: p => typeof p === "string" && /^https?:\/\//i.test(p.trim()),
      });

      await new Promise(r => setTimeout(r, 20));
      const item = { key: "k1", label: "Doc", target: { rootID: "r1", notebook: "b1", blockID: "blk1", imageOrdinal: 0, oldPath: "assets/a.png" } };

      await dock.applyOccurrenceAction(rec, "original", [item]);
      assert.equal(notifications.at(-1), 'image.records.replaceResult:{"replaced":1}');

      commitOutcome = "conflict";
      await dock.applyOccurrenceAction(rec, "original", [item]);
      assert.equal(notifications.at(-1), 'image.records.replaceResult:{"replaced":0}image.records.resultConflicts:{"conflicts":1}');
      mountCleanup?.();
    }

    // 7. Remote records skip originalPath status checks, pass scopeBox for ?box= encrypted originals, allow restore without original status, and skip checkAssetAvailability when restoring to remote URL
    {
      const boxID = "20260101000001-abcdef0";
      const remoteRec = {
        originalPath: "https://cdn.example/remote.png?token=1",
        compressedPath: `assets/remote.png?box=${boxID}`,
        updatedAt: 10,
        lastOperation: "replaced",
      };
      let currentRecords = [remoteRec];
      const subs = new Set();
      const locateCalls = [];
      const checkAvailCalls = [];
      const commitCalls = [];
      const store = {
        store: {
          subscribe(fn) {
            subs.add(fn);
            fn({ records: currentRecords });
            return () => subs.delete(fn);
          },
        },
        snapshot: () => currentRecords,
        markOperation: async () => {},
        removeRecord: async () => {},
      };

      let mountCleanup;
      const dock = factory({
        props: { context: { plugin: {}, logger: { debug() {}, warn() {} }, feedback: { notify() {}, copyable: async () => true } }, t: k => k },
        onMount: fn => { mountCleanup = fn(); },
        untrack: fn => fn(),
        Dialog: class {},
        openTab: () => {},
        isAbortError: e => e?.name === "AbortError",
        KernelClient: class {},
        imageRecordsFor: () => ({ store, ready: Promise.resolve() }),
        blockDOM: async () => "",
        ReferenceService: class {
          async commitOccurrence(target, nextPath) {
            commitCalls.push({ oldPath: target.oldPath, nextPath });
            return "replaced";
          }
        },
        checkAssetAvailability: async (_kernel, path) => {
          checkAvailCalls.push(path);
          return "present";
        },
        locateAssetOccurrences: async (_kernel, _origin, searchPath, _t, _signal, options) => {
          locateCalls.push({ searchPath, options });
          return {
            ok: true,
            complete: true,
            items: [],
            unsupported: [],
            skippedNotebooks: [],
            unavailableAttributeViews: 0,
            metadataIncomplete: false,
            encryptedUnavailable: false,
          };
        },
        reconcileRecordPair: async () => ({ original: "present", compressed: "present", removed: false }),
        resolveImageOccurrence: () => undefined,
        findLinkCandidates: () => [],
        sameSource: (a, b) => a === b,
        trySource: p => p.includes(`?box=${boxID}`) ? { kind: "asset", box: boxID } : null,
        isRemoteRecordSource: p => typeof p === "string" && /^https?:\/\//i.test(p.trim()),
      });

      await new Promise(r => setTimeout(r, 20));
      const statuses = dock.getState().assetStatuses;
      assert.equal(remoteRec.originalPath in statuses, false, "remote originalPath must not be tracked in assetStatuses");
      assert.equal(statuses[remoteRec.compressedPath], "present");

      await dock.locateOccurrences(remoteRec, "original", "user_click");
      assert.deepEqual(locateCalls.at(-1), {
        searchPath: remoteRec.originalPath,
        options: { scopeBox: boxID },
      });

      // Restore button / locateRestoreOccurrences works for remote records even without original status
      await dock.locateRestoreOccurrences(remoteRec);
      assert.deepEqual(locateCalls.at(-1), {
        searchPath: remoteRec.compressedPath,
        options: undefined,
      });

      // Restoring to remote URL skips checkAssetAvailability and uses sameSource
      const prevCheckCount = checkAvailCalls.length;
      await dock.applyOccurrenceAction(remoteRec, "compressed", [{
        key: "k-remote",
        label: "Doc",
        target: { rootID: "r1", notebook: boxID, blockID: "blk1", imageOrdinal: 0, oldPath: remoteRec.compressedPath },
      }]);
      assert.equal(checkAvailCalls.length, prevCheckCount);
      assert.deepEqual(commitCalls, [{ oldPath: remoteRec.compressedPath, nextPath: remoteRec.originalPath }]);
      mountCleanup?.();
    }
  } finally {
    globalThis.window = prevWindow;
  }
});

test("reconcileRecordPair skips checkAsset on remote originalPath and removes only when local original is missing-confirmed", async () => {
  const storage = new Map();
  const plugin = {
    async loadData(p) { return storage.has(p) ? structuredClone(storage.get(p)) : ""; },
    async saveData(p, d) { storage.set(p, structuredClone(d)); },
  };
  const store = new ImageCompressionRecordStore(plugin, { fetchFn: createFileGetFetch(storage) });
  await store.init();
  const remoteURL = "https://cdn.example/remote.png";
  const localOrig = "assets/remote-local.png";
  await store.upsert(remoteURL, localOrig);
  await store.upsert(localOrig, "assets/remote-local.webp");

  const checkedPaths = [];
  const rec = store.snapshot().find(r => r.originalPath === remoteURL);

  const presentRes = await reconcileRecordPair(rec, async p => {
    checkedPaths.push(p);
    return "present";
  }, store);
  assert.deepEqual(checkedPaths, [localOrig]);
  assert.equal(presentRes.original, "present");
  assert.equal(presentRes.compressed, "present");
  assert.equal(presentRes.removed, false);
  assert.equal(store.snapshot().length, 2);

  checkedPaths.length = 0;
  const missingRes = await reconcileRecordPair(rec, async p => {
    checkedPaths.push(p);
    return "missing-confirmed";
  }, store);
  assert.deepEqual(checkedPaths, [localOrig]);
  assert.equal(missingRes.removed, true);
  assert.deepEqual(store.snapshot().map(r => r.originalPath), [localOrig]);
});

test("locateAssetOccurrences locates remote URLs via readonly SQL + live DOM verification and supports scopeBox", async () => {
  const rootID = "20260101000000-abcdef0";
  const boxID = "20260101000001-abcdef0";
  const blockID = "20260101000002-abcdef0";
  const remoteURL = "https://CDN.example/a_b%20'q.png?v=1\\x";
  const normalizedURL = new URL(remoteURL).href;
  const dom = `<div data-node-id="${blockID}"><img data-src="${remoteURL}" src="${remoteURL}"><a href="${remoteURL}">ref</a></div>`;

  const priorDoc = globalThis.document;
  const imgEl = {
    tagName: "IMG",
    hasAttribute: n => n === "data-src" || n === "src",
    getAttribute: n => (n === "data-src" || n === "src" ? remoteURL : null),
    closest: sel => (sel === "[data-node-id]" ? { getAttribute: () => blockID, querySelector: () => null } : null),
  };
  const linkEl = {
    tagName: "A",
    textContent: "ref",
    hasAttribute: n => n === "href",
    getAttribute: n => (n === "href" ? remoteURL : null),
    closest: sel => (sel === "[data-node-id]" ? { getAttribute: () => blockID, querySelector: () => null } : null),
  };
  const blockRoot = {
    getAttribute: n => (n === "data-node-id" ? blockID : null),
    querySelector: () => null,
    querySelectorAll: sel => {
      if (sel === "img") return [imgEl];
      if (sel === "a[href], span[data-href]") return [linkEl];
      return [];
    },
  };
  globalThis.document = {
    createElement: () => ({
      content: {
        children: [blockRoot],
        querySelectorAll: sel => (sel === "img" ? [imgEl] : sel === "a[href], span[data-href]" ? [linkEl] : []),
      },
      set innerHTML(_) {},
    }),
  };

  try {
    const sqlRequests = [];
    const sqlKernel = {
      async post(url, body) {
        if (url === "/api/query/sql") {
          sqlRequests.push(body);
          return { code: 0, data: [{ id: blockID, root_id: rootID, box: boxID }], truncated: false };
        }
        if (url === "/api/block/getBlockDOMs") {
          return { code: 0, data: { [blockID]: dom } };
        }
        if (url === "/api/filetree/getFullHPathByID") {
          return { code: 0, data: "/Remote Note" };
        }
        throw new Error(url);
      },
    };

    const sqlResult = await locateAssetOccurrences(sqlKernel, "http://localhost:6806", normalizedURL, k => k);
    assert.equal(sqlRequests.length, 1);
    assert.equal(sqlRequests[0].mode, "readonly");
    assert.match(sqlRequests[0].stmt, /LOWER\(markdown\) LIKE '%cdn\.example%' ESCAPE '\\'/);
    assert.match(sqlRequests[0].stmt, /LOWER\(markdown\) LIKE '%\/a\\_b\\%20''q\.png%' ESCAPE '\\'/);
    assert.match(sqlRequests[0].stmt, /LOWER\(markdown\) LIKE '%\/a\\_b ''q\.png%' ESCAPE '\\'/);
    assert.match(
      sqlRequests[0].stmt,
      /type NOT IN \('d', 'b', 'l', 'i', 's', 'callout', 'tabs', 'tab', 'mindmap', 'mindmap_item'\) LIMIT 200/,
    );
    assert.equal(sqlResult.ok, true);
    assert.equal(sqlResult.complete, true);
    assert.equal(sqlResult.items.length, 2);

    // Truncated SQL marks complete = false
    const truncatedKernel = {
      async post(url) {
        if (url === "/api/query/sql") {
          return { code: 0, data: [{ id: blockID, root_id: rootID, box: boxID }], truncated: true };
        }
        if (url === "/api/block/getBlockDOMs") return { code: 0, data: { [blockID]: dom } };
        if (url === "/api/filetree/getFullHPathByID") return { code: 0, data: "/Remote Note" };
        throw new Error(url);
      },
    };
    const truncatedRes = await locateAssetOccurrences(truncatedKernel, "http://localhost:6806", normalizedURL, k => k);
    assert.equal(truncatedRes.complete, false);

    // scopeBox routes remote URL lookup through encrypted notebook scan
    const scopedKernel = {
      async post(url, body) {
        if (url === "/api/query/sql") throw new Error("Must not use SQL when scopeBox is set");
        if (url === "/api/notebook/lsNotebooks") return { code: 0, data: { notebooks: [{ id: boxID, closed: false, name: "Enc" }] } };
        if (url === "/api/filetree/listDocsByPath") return { code: 0, data: { files: [{ id: rootID, path: `/${rootID}.sy`, name: "EncNote", subFileCount: 0 }] } };
        if (url === "/api/block/getBlockDOMs") return { code: 0, data: { [body.ids[0]]: dom } };
        if (url === "/api/filetree/getFullHPathByID") return { code: 0, data: "/EncNote" };
        throw new Error(url);
      },
    };
    const scopedRes = await locateAssetOccurrences(scopedKernel, "http://localhost:6806", normalizedURL, k => k, undefined, { scopeBox: boxID });
    assert.equal(scopedRes.ok, true);
    assert.equal(scopedRes.items.length, 2);
  } finally {
    globalThis.document = priorDoc;
  }
});

test("D-BUG-01: ?box= locator reports open-but-locked encrypted notebook as encryptedUnavailable, passes showHidden: true, and handles boxDocEnabled existing vs absent root doc", async () => {
  const boxID = "20260101000001-abcdef0";
  const blockID = "20260101000002-abcdef0";
  const searchPath = `assets/enc.png?box=${boxID}`;
  const boxDocDOM = `<div data-node-id="${boxID}"><div data-node-id="${blockID}"><img data-src="${searchPath}" src="${searchPath}"></div></div>`;
  const blockDOMStr = `<div data-node-id="${blockID}"><img data-src="${searchPath}" src="${searchPath}"></div>`;

  // 1. Open but locked encrypted notebook (closed: false, encrypted: true, unlocked: false) -> encryptedUnavailable: true
  {
    const lockedOpenKernel = {
      async post(url) {
        if (url === "/api/notebook/lsNotebooks") {
          return {
            code: 0,
            data: { notebooks: [{ id: boxID, closed: false, encrypted: true, unlocked: false, name: "Vault" }] },
          };
        }
        throw new Error(`Must not call ${url} on locked encrypted notebook`);
      },
    };
    const res = await locateAssetOccurrences(lockedOpenKernel, "http://localhost:6806", searchPath, k => k);
    assert.equal(res.ok, false);
    assert.equal(res.complete, false);
    assert.equal(res.encryptedUnavailable, true);
    assert.deepEqual(res.skippedNotebooks, [boxID]);
  }

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
          querySelectorAll: sel => (currentHtml === boxDocDOM && sel === "img" ? [imgNode] : []),
        },
        set innerHTML(v) { currentHtml = v; },
      };
    },
  };

  try {
    // 2. Unlocked encrypted notebook + boxDocEnabled with existing root doc -> showHidden: true + root doc scanned
    const listBodies = [];
    const existingBoxDocKernel = {
      async post(url, body) {
        if (url === "/api/notebook/lsNotebooks") {
          return {
            code: 0,
            data: {
              notebooks: [{ id: boxID, closed: false, encrypted: true, unlocked: true, boxDocEnabled: true, name: "Vault" }],
            },
          };
        }
        if (url === "/api/filetree/listDocsByPath") {
          listBodies.push(body);
          return { code: 0, data: { files: [] } };
        }
        if (url === "/api/block/getBlockInfo") {
          assert.deepEqual(body, { id: boxID, notebook: boxID });
          return { code: 0, data: { id: boxID, rootID: boxID, rootTitle: "Vault Root" } };
        }
        if (url === "/api/block/getBlockDOMs") {
          if (body.ids.includes(boxID)) return { code: 0, data: { [boxID]: boxDocDOM } };
          if (body.ids.includes(blockID)) return { code: 0, data: { [blockID]: blockDOMStr } };
          return { code: 0, data: {} };
        }
        if (url === "/api/filetree/getFullHPathByID") {
          return { code: 0, data: "/Vault Root" };
        }
        throw new Error(url);
      },
    };
    const existingRes = await locateAssetOccurrences(existingBoxDocKernel, "http://localhost:6806", searchPath, k => k);
    assert.equal(listBodies.length, 1);
    assert.equal(listBodies[0].showHidden, true);
    assert.equal(existingRes.ok, true);
    assert.equal(existingRes.complete, true);
    assert.equal(existingRes.items.length, 1);
    assert.equal(existingRes.items[0].target.rootID, boxID);

    // 3. boxDocEnabled with uncreated (non-existent) root doc -> must NOT mark complete = false
    const absentBoxDocKernel = {
      async post(url, body) {
        if (url === "/api/notebook/lsNotebooks") {
          return {
            code: 0,
            data: {
              boxDocEnabled: true,
              notebooks: [{ id: boxID, closed: false, encrypted: true, unlocked: true, name: "Vault" }],
            },
          };
        }
        if (url === "/api/filetree/listDocsByPath") {
          assert.equal(body.showHidden, true);
          return { code: 0, data: { files: [] } };
        }
        if (url === "/api/block/getBlockInfo") {
          throw Object.assign(new Error("Block not found"), { outcome: "rejected", code: -1 });
        }
        if (url === "/api/block/getBlockDOMs") {
          return { code: 0, data: {} };
        }
        throw new Error(url);
      },
    };
    const absentRes = await locateAssetOccurrences(absentBoxDocKernel, "http://localhost:6806", searchPath, k => k);
    assert.equal(absentRes.ok, true);
    assert.equal(absentRes.complete, true, "uncreated notebook root doc must not degrade complete to false");
    assert.equal(absentRes.items.length, 0);
  } finally {
    globalThis.document = priorDoc;
  }
});

test("D-BUG-02: locateAssetOccurrences routes avID, html, title-image, and empty-DOM references into unsupported with complete === false", async () => {
  const rootID = "20260101000000-abcdef0";
  const boxID = "20260101000001-abcdef0";
  const blockImgAndTitle = "20260101000002-abcdef0";
  const blockHtml = "20260101000003-abcdef0";
  const blockAv = "20260101000004-abcdef0";
  const blockUnmappable = "20260101000005-abcdef0";

  const priorDoc = globalThis.document;
  const imgNode = {
    tagName: "IMG",
    hasAttribute: n => n === "data-src" || n === "src",
    getAttribute: n => (n === "data-src" || n === "src" ? "assets/a.png" : null),
    closest: () => null,
  };
  globalThis.document = {
    createElement: () => {
      let html = "";
      return {
        set innerHTML(v) { html = v; },
        get content() {
          const isImgBlock = html.includes(blockImgAndTitle);
          const id = isImgBlock ? blockImgAndTitle : blockUnmappable;
          return {
            children: [{
              getAttribute: n => (n === "data-node-id" ? id : null),
              querySelector: () => null,
              querySelectorAll: sel => (isImgBlock && sel === "img" ? [imgNode] : []),
            }],
            querySelectorAll: () => [],
          };
        },
      };
    },
  };

  try {
    const domRequestedIds = [];
    const kernel = {
      async post(url, body) {
        if (url === "/api/asset/findAssetReferences") {
          return {
            code: 0,
            data: {
              references: [
                // Same blockID has both a title-image AND a normal image -> neither must shadow the other!
                { type: "title-image", rootID, notebook: boxID, blockID: blockImgAndTitle, relinkable: true, reference: "assets/a.png" },
                { type: "image", rootID, notebook: boxID, blockID: blockImgAndTitle, relinkable: true, reference: "assets/a.png" },
                // AV cell with relinkable: true and avID
                { type: "av-asset", rootID, notebook: boxID, blockID: blockAv, avID: "20260101000099-av12345", relinkable: true, reference: "assets/a.png" },
                // HTML block with relinkable: true
                { type: "html", rootID, notebook: boxID, blockID: blockHtml, relinkable: true, reference: "assets/a.png" },
                // Orphan AV without rootID -> counted into unavailableAttributeViews
                { type: "av-url", rootID: "", avID: "20260101000098-av00000", relinkable: true, reference: "assets/a.png" },
                // Ordinary block that yields 0 DOM occurrences (e.g. file annotation / protected container)
                { type: "annotation", rootID, notebook: boxID, blockID: blockUnmappable, relinkable: true, reference: "assets/a.png" },
              ],
              skippedNotebooks: [],
              unavailableAttributeViews: [],
            },
          };
        }
        if (url === "/api/block/getBlockDOMs") {
          domRequestedIds.push(...body.ids);
          return {
            code: 0,
            data: {
              [blockImgAndTitle]: `<div data-node-id="${blockImgAndTitle}"><img data-src="assets/a.png" src="assets/a.png"></div>`,
              [blockUnmappable]: `<div data-node-id="${blockUnmappable}"><span data-type="file-annotation-ref">ref</span></div>`,
            },
          };
        }
        if (url === "/api/filetree/getFullHPathByID") {
          return { code: 0, data: "/Test Doc" };
        }
        throw new Error(url);
      },
    };

    const res = await locateAssetOccurrences(kernel, "http://localhost:6806", "assets/a.png", k => k);
    assert.equal(res.ok, true);
    assert.equal(res.complete, false, "non-DOM references must set complete === false so record is never falsely marked replaced");
    assert.equal(res.items.length, 1);
    assert.equal(res.items[0].target.blockID, blockImgAndTitle);
    assert.equal(res.unavailableAttributeViews, 1, "unsupported row without rootID must increment unavailableAttributeViews");
    assert.deepEqual(domRequestedIds, [blockImgAndTitle, blockUnmappable], "avID and html rows must not fetch block DOM");
    assert.equal(res.unsupported.length, 4, "title-image, avID, html, and 0-item block must all appear in unsupported");
  } finally {
    globalThis.document = priorDoc;
  }
});
