import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { FeatureScope } from "../../../src/core/framework/FeatureScope.ts";
import { TaskRegistry } from "../../../src/features/image-compressor/policy/TaskRegistry.ts";
import { ImageController } from "../../../src/features/image-compressor/ImageController.ts";
import { compressDocumentImages } from "../../../src/features/image-compressor/actions/DocumentBatchAction.ts";
import { resolveDocumentTitle } from "../../../src/features/image-compressor/services/documentTitle.ts";
import { defaultImageFeatureConfig } from "../../../src/features/image-compressor/policy/parseImageConfig.ts";

const read = path => readFile(new URL(path, import.meta.url), "utf8");

test("SingleImageAction separates quiet cancellation from error handling", async () => {
  const action = await read("../../../src/features/image-compressor/actions/SingleImageAction.ts");

  assert.match(action, /const signal = scope\.signal;\s*if \(!scope\.active \|\| signal\.aborted\) return;\s*if \(editor\.disabled\) return \{ kind: "notify", key: "image\.single\.invalidTarget" \};/);
  assert.match(action, /let target = await resolveSelectedOccurrence\(menuDetail, editor, services, signal\);\s*if \(!scope\.active \|\| signal\.aborted\) return;\s*if \(!target\) return \{ kind: "notify", key: "image\.single\.unmappable" \};/);
  assert.match(action, /const target = await resolveSelectedOccurrence\(menuDetail, editor, services, signal\);\s*if \(!scope\.active \|\| signal\.aborted\) return;\s*if \(!target\) return \{ kind: "notify", key: "image\.single\.unmappable" \};/);

  const quickBody = action.slice(action.indexOf("export async function compressSelectedImageQuick"), action.indexOf("export async function compressSelectedImageCustom"));
  assert.doesNotMatch(quickBody, /services\.ui\.notify/);
});

test("DocumentBatchAction returns cancelled quietly without returning invalid summary early on abort", async () => {
  const batch = await read("../../../src/features/image-compressor/actions/DocumentBatchAction.ts");
  assert.match(batch, /if \(signal\.aborted \|\| !scope\.active\) \{\s*return cancelledSummary\(summary\);\s*\}\s*if \(!rootID \|\| protyle\?\.disabled\) \{\s*return summary;\s*\}/);
});

test("DocumentBatchAction scans document once via getBlockDOM and slices single blocks in memory", async () => {
  const batch = await read("../../../src/features/image-compressor/actions/DocumentBatchAction.ts");
  assert.match(batch, /\/api\/block\/getBlockDOM",\s*\{\s*id:\s*rootID,\s*notebook:\s*targetNotebook\s*\}/);
  assert.match(batch, /domRes\.data\?\.id !== rootID/);
  assert.match(batch, /scanDocumentImages\(docDOM,\s*services\.origin,\s*config\)/);
  assert.doesNotMatch(batch, /sliceImageBlockDOMs|WHERE type = 'p'|mode:\s*["']write["']|getBlockDOMs/);
});

test("RemoteImageWatcher guards against unauthorized documents before taking snapshot or HTTP calls", async () => {
  const watcher = await read("../../../src/features/image-compressor/actions/RemoteImageWatcher.ts");
  assert.match(watcher, /async function rebuildBaseline\([\s\S]*?if \(!autoAllowed\(services\.config\(\), doc\.id\)\) \{\s*stopWatching\(\);\s*return;\s*\}/);
  assert.match(watcher, /await rebuildBaseline\(initSignal\);/);
  assert.match(watcher, /async function sweep\([^)]*\): Promise<void> \{\s*if \([\s\S]*?\) return;\s*if \(!autoAllowed\(services\.config\(\), doc\.id\)\) return;\s*if \(reading\)/);
});

test("ImageController does not abort on switch-protyle/destroy-protyle, uses createRuntimeId and closingByController, and guards activeDocuments (D07, I-08, I-09)", async () => {
  const controllerSrc = await read("../../../src/features/image-compressor/ImageController.ts");
  const featureSrc = await read("../../../src/features/image-compressor/ImageCompressorFeature.ts");
  const uiSrc = await read("../../../src/features/image-compressor/ui/ImageTaskUI.ts");

  assert.doesNotMatch(controllerSrc, /switch-protyle|destroy-protyle|crypto\.randomUUID|nextTaskId|referenceResult/);
  assert.match(controllerSrc, /createRuntimeId\("img-task"\)/);
  assert.match(controllerSrc, /if \(result\.cancelled\) \{\s*view\.close\(\);\s*return;\s*\}/);
  assert.match(controllerSrc, /if \(result\.total === 0 && result\.scanComplete\) \{\s*view\.close\(\);/);
  assert.match(controllerSrc, /if \(!result\.scanComplete\) \{\s*view\.close\(\);/);
  assert.match(controllerSrc, /activeDocuments\.has\(rootID\)/);
  assert.match(controllerSrc, /activeDocuments\.add\(rootID\)/);
  assert.match(controllerSrc, /activeDocuments\.delete\(rootID\)/);

  assert.doesNotMatch(featureSrc, /protected onDisable\(\): void \{\s*this\.tasks\.cancelAll\("Feature disabled"\);\s*\}/);
  assert.match(featureSrc, /resolveDocument\(menu\.rootID, ctx\.logger, notebookId, scope\.signal\)/);
  assert.doesNotMatch(featureSrc, /resolveDocumentTitle/);
  assert.match(featureSrc, /this\.pages\.toggle\(menu\.rootID\)/);

  // mountDialog distinguishes programmatic close from user dismissal
  assert.match(uiSrc, /closingByController/);
  assert.match(uiSrc, /if \(!closingByController\) \{\s*onClose\(\);\s*\}/);
});

test("ImageController keeps background batch running across editor switch/destroy, releases activeDocuments on init error, and aborts only on dialog close (D07, I-08, I-09)", async () => {
  const rootID = "20260101000000-abcdef0";
  const boxID = "20260101000001-abcdef0";
  const scope = new FeatureScope();
  const tasks = new TaskRegistry();
  const notices = [];
  const busHandlers = new Map();

  const ctx = {
    plugin: {
      i18n: {
        "image.batch.scanFailed": "Scan failed",
        "image.batch.noImages": "No images",
        "image.batch.alreadyRunning": "Already running",
      },
      eventBus: {
        on(name, fn) { busHandlers.set(name, fn); },
        off(name) { busHandlers.delete(name); },
      },
    },
    feedback: { notify(msg, type) { notices.push({ msg, type }); } },
    logger: { warn() {}, error() {}, debug() {} },
    statusBar: { update() {}, clear() {} },
  };

  // 1. Early error in ui.progress must release activeDocuments and TaskRegistry
  let throwProgress = true;
  let capturedOnClose;
  let viewClosed = 0;
  const services = {
    origin: "http://localhost:6806",
    mobile: false,
    config: () => defaultImageFeatureConfig(),
    kernel: {
      async post(url) {
        if (url === "/api/block/getBlockInfo") throw new Error("Scan fail");
        throw new Error(url);
      },
    },
    ui: {
      progress(_store, onClose) {
        if (throwProgress) throw new Error("Mount failed");
        capturedOnClose = onClose;
        return { close() { viewClosed++; } };
      },
      notify(msg) { notices.push({ msg, type: "info" }); },
    },
  };

  const controller = new ImageController(ctx, scope, services, tasks);
  await controller.compressDocument({}, rootID);
  assert.equal(tasks.activeCount, 0);

  // 2. Second attempt succeeds (proves activeDocuments was released), scan fails -> closes UI without marking cancelled
  throwProgress = false;
  await controller.compressDocument({}, rootID);
  assert.equal(viewClosed, 1);
  assert.equal(tasks.activeCount, 0);
  assert.equal(notices.some(n => n.msg === "Scan failed"), true);

  // 3. No switch-protyle/destroy-protyle listeners registered
  assert.equal(busHandlers.has("switch-protyle"), false);
  assert.equal(busHandlers.has("destroy-protyle"), false);
  assert.equal(typeof capturedOnClose, "function");
  scope.dispose();
});

test("DocumentBatchAction processes ?box= assets, reports two-phase progress with live uploaded, and separates unknown count (P2-1, P2-4, I-13)", async () => {
  const rootID = "20260101000000-abcdef0";
  const boxID = "20260101000001-abcdef0";
  const blockID = "20260101000002-abcdef0";
  const docDOM = `<div data-node-id="${rootID}"><div data-node-id="${blockID}"><img data-src="assets/a.png?box=${boxID}" src="assets/a.png?box=${boxID}"><img data-src="assets/b.png?box=${boxID}" src="assets/b.png?box=${boxID}"></div></div>`;
  const block1DOM = `<div data-node-id="${blockID}"><img data-src="assets/a.png?box=${boxID}" src="assets/a.png?box=${boxID}"><img data-src="assets/b.png?box=${boxID}" src="assets/b.png?box=${boxID}"></div>`;
  const block2DOM = `<div data-node-id="${blockID}"><img data-src="assets/a.webp?box=${boxID}" src="assets/a.webp?box=${boxID}"><img data-src="assets/b.png?box=${boxID}" src="assets/b.png?box=${boxID}"></div>`;

  const priorDOMParser = globalThis.DOMParser;
  const priorDocument = globalThis.document;
  const makeImg = (src) => ({
    attrs: { "data-src": src, src },
    hasAttribute: n => n in { "data-src": src, src },
    getAttribute: n => (n === "data-src" || n === "src" ? src : null),
    closest(sel) {
      if (sel === "[data-node-id]") return this.owner;
      return null;
    },
  });
  const imgA = makeImg(`assets/a.png?box=${boxID}`);
  const imgB = makeImg(`assets/b.png?box=${boxID}`);
  const blockEl = {
    getAttribute: n => (n === "data-node-id" ? blockID : null),
    querySelector: () => null,
    querySelectorAll: sel => (sel === "img" ? [imgA, imgB] : []),
    outerHTML: block1DOM,
  };
  imgA.owner = blockEl;
  imgB.owner = blockEl;

  globalThis.DOMParser = class {
    parseFromString() {
      return {
        querySelector: () => null,
        querySelectorAll: sel => (sel === "img" ? [imgA, imgB] : sel === "[data-node-id]" ? [blockEl] : []),
      };
    }
  };
  globalThis.document = {
    createElement: () => {
      let html = "";
      return {
        content: {
          get children() {
            const matches = [...html.matchAll(/data-src="([^"]+)"/g)].map(m => ({
              hasAttribute: n => n === "data-src" || n === "src",
              getAttribute: () => m[1],
            }));
            return [{
              getAttribute: n => (n === "data-node-id" ? blockID : null),
              querySelector: () => null,
              querySelectorAll: sel => (sel === "img" ? matches : []),
            }];
          },
        },
        set innerHTML(v) { html = v; },
      };
    },
  };

  const scope = new FeatureScope();
  try {
    const progressEvents = [];
    const markOps = [];
    let currentBlockDOM = block1DOM;

    const blockDOMReads = [];
    const services = {
      origin: "http://localhost:6806",
      mobile: true, // sequential prepare for deterministic progress check
      config: () => defaultImageFeatureConfig(),
      kernel: {
        async post(url, body) {
          if (url === "/api/block/getBlockInfo") return { data: { id: rootID, type: "d", rootID, box: boxID } };
          if (url === "/api/block/getBlockDOM") {
            blockDOMReads.push(body?.id);
            return { data: { id: rootID === body?.id ? rootID : blockID, dom: body?.id === rootID ? docDOM : currentBlockDOM } };
          }
          throw new Error(url);
        },
      },
      async compressOccurrence(target) {
        const isA = target.oldPath.includes("a.png");
        return {
          status: "saved",
          path: isA ? `assets/a.webp?box=${boxID}` : `assets/b.webp?box=${boxID}`,
          reference: "not-requested",
          originalBytes: 2000,
          compressedBytes: 1000,
        };
      },
      references: {
        async commitOccurrenceDetailed(target, newPath) {
          if (newPath.includes("a.webp")) {
            assert.equal(target.imageOrdinal, 0);
            assert.equal(blockDOMReads.includes(blockID), false);
            currentBlockDOM = block2DOM;
            return { status: "replaced" };
          }
          assert.equal(blockDOMReads.includes(blockID), false);
          assert.equal(target.imageOrdinal, 1);
          return { status: "unknown" };
        },
      },
      records: {
        async markOperation(orig, comp, status) {
          markOps.push({ orig, comp, status });
        },
      },
    };

    const summary = await compressDocumentImages(
      {},
      { logger: { warn() {} } },
      scope,
      services,
      {
        rootID,
        notebook: boxID,
        onProgress: p => progressEvents.push(p),
      },
    );

    assert.equal(summary.scanComplete, true);
    assert.equal(summary.succeeded, 1);
    assert.equal(summary.unknown, 1);
    assert.equal(summary.failed, 0);
    assert.equal(summary.uploaded, 2);

    const preparing = progressEvents.filter(p => p.phase === "preparing");
    const applying = progressEvents.filter(p => p.phase === "applying");
    assert.ok(preparing.length >= 2);
    assert.ok(applying.length >= 1);
    assert.ok(preparing.some(p => p.uploaded === 1));
    assert.equal(preparing[preparing.length - 1].prepared, 2);
    assert.equal(preparing[preparing.length - 1].preparedTotal, 2);

    assert.deepEqual(markOps, [
      { orig: `assets/a.png?box=${boxID}`, comp: `assets/a.webp?box=${boxID}`, status: "replaced" },
      { orig: `assets/b.png?box=${boxID}`, comp: `assets/b.webp?box=${boxID}`, status: "incomplete" },
    ]);
  } finally {
    globalThis.DOMParser = priorDOMParser;
    globalThis.document = priorDocument;
    scope.dispose();
  }
});

test("resolveDocumentTitle falls back to rootTitle and then rootID on API failure (I-16, I-24)", async () => {
  const rootID = "20260101000000-abcdef0";
  const failingKernel = {
    async post() { throw new Error("network error"); },
  };
  assert.equal(await resolveDocumentTitle(failingKernel, rootID, { fallbackRootTitle: "My Doc" }), "My Doc");
  assert.equal(await resolveDocumentTitle(failingKernel, rootID), rootID);
});
