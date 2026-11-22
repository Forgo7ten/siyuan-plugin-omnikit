import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { FeatureScope } from "../../../src/core/framework/FeatureScope.ts";
import { defaultImageFeatureConfig, parseImageConfig } from "../../../src/features/image-compressor/policy/parseImageConfig.ts";

const read = path => readFile(new URL(path, import.meta.url), "utf8");

test("image context menu exposes only quick and custom compression actions", async () => {
  const menu = await read("../../../src/features/image-compressor/actions/menuContributions.ts");
  assert.match(menu, /id: "compress-image-quick"/);
  assert.match(menu, /id: "compress-image-custom"/);
  assert.match(menu, /label:\s*deps\.t\("menu\.compressImageQuick"\)/);
  assert.match(menu, /label:\s*deps\.t\("menu\.compressImageCustom"\)/);
  assert.doesNotMatch(menu, /compress-image-from-file|compressFromFile|pickImage/);
  assert.doesNotMatch(menu, /`\[OmniKit\] \$\{value\}`/);
});

test("quick compression targets one occurrence and uses manual quick mode", async () => {
  const action = await read("../../../src/features/image-compressor/actions/SingleImageAction.ts");
  assert.match(action, /resolveSelectedOccurrence\(menuDetail, editor, services, signal\)/);
  assert.match(action, /services\.compressOccurrence\(target, services\.config\(\), signal, \{\s*replace: true,\s*mode: "manual-quick"/);
  assert.match(action, /services\.references\.commitOccurrence\(target, localPath, signal\)/);
});

test("manual compression previews in memory, hides EXIF UI controls, and saves through savePreview (D09)", async () => {
  const action = await read("../../../src/features/image-compressor/actions/SingleImageAction.ts");
  const ui = await read("../../../src/features/image-compressor/ui/ImageTaskUI.ts");
  const dialog = await read("../../../src/features/image-compressor/ui/ImageCompressionDialog.svelte");
  const settingsPanel = await read("../../../src/features/image-compressor/ui/ImageSettingsPanel.svelte");

  assert.match(action, /services\.encoder\.encode\([\s\S]*?"manual-dialog"\)/);
  assert.match(action, /services\.savePreview\(localizedTarget, preview\.file, signal, replace, metrics\)/);
  assert.match(action, /previewOriginal = original/);
  const customAction = action.slice(action.indexOf("export async function compressSelectedImageCustom"), action.indexOf("export async function localizeRemoteOccurrence"));
  const opening = customAction.slice(0, customAction.indexOf("save: async"));
  assert.doesNotMatch(opening, /assets\.upload|records\.upsert|references\.commitOccurrence|savePreview/);
  assert.match(customAction, /onClose = \(\) => \{\s*signal\.removeEventListener\("abort", relayAbort\);\s*previewAbort\.abort/);
  assert.match(ui, /manualCompression\(options\)/);
  assert.doesNotMatch(ui, /pickImage/);
  assert.match(dialog, /let replaceCurrent = \$state\(false\)/);
  assert.match(dialog, /URL\.createObjectURL\(encoded\.file\)/);
  assert.match(dialog, /URL\.revokeObjectURL\(previewURL\)/);
  assert.doesNotMatch(dialog, /window\.confirm|>\s*取消\s*</);

  // D09: No visible EXIF UI controls in either dialog or settings panel; schema preserves default false
  assert.doesNotMatch(dialog, /image\.dialog\.preserveExif/);
  assert.doesNotMatch(settingsPanel, /settings\.preserveExif|settings\.metadata/);
  assert.equal(defaultImageFeatureConfig().metadata.preserveExif, false);
  assert.throws(() => parseImageConfig({ ...defaultImageFeatureConfig(), metadata: { preserveExif: true } }));
});

test("savePreview with replace: false generates asset and record with zero updateBlock calls for local assets", async () => {
  const { savePreview } = await import("../../../src/features/image-compressor/services/ImageProcessingServices.ts");
  let updateBlockCalls = 0;
  let recordUpsertCalls = 0;
  const webpFile = new File(["dummy-webp"], "output.webp", { type: "image/webp" });
  const mockServices = {
    origin: "https://siyuan.test",
    config: () => ({ compression: { maxInputBytes: 10 * 1024 * 1024 } }),
    assets: {
      upload: async () => "assets/output.webp",
    },
    recordsReady: Promise.resolve(),
    records: {
      upsert: async () => { recordUpsertCalls++; },
      markOperation: async () => {},
    },
    references: {
      commitOccurrence: async () => {
        updateBlockCalls++;
        return "replaced";
      },
    },
    ui: {
      copyablePath: () => {},
    },
  };

  const target = {
    rootID: "20240101000000-abcdefg",
    notebook: "20240101000000-hijklmn",
    blockID: "20240101000000-opqrstu",
    imageOrdinal: 0,
    oldPath: "assets/original.png",
  };

  const result = await savePreview(
    mockServices,
    target,
    webpFile,
    new AbortController().signal,
    false, // replace: false
  );

  assert.equal(result.status, "saved");
  assert.equal(result.reference, "not-requested");
  assert.equal(result.path, "assets/output.webp");
  assert.equal(recordUpsertCalls, 1);
  assert.equal(updateBlockCalls, 0);
});

test("D02: remote image in compressSelectedImageCustom with replace=false localizes single occurrence, recaptures fresh block DOM, and keeps local original", async () => {
  const { compressSelectedImageCustom } = await import("../../../src/features/image-compressor/actions/SingleImageAction.ts");

  const rootID = "20240101000000-abcdefg";
  const notebook = "20240101000000-hijklmn";
  const blockID = "20240101000000-opqrstu";
  const remoteURL = "https://example.com/test.png";
  const remoteDOM = `<div data-node-id="${blockID}"><img src="${remoteURL}"></div>`;
  const localizedDOM = `<div data-node-id="${blockID}"><img src="assets/test.png"></div>`;

  let currentDOM = remoteDOM;
  const commitCalls = [];
  const upserts = [];
  const markOps = [];
  const copyPrompts = [];
  let dialogOptions;

  const priorDoc = globalThis.document;
  const makeNode = (domStr) => {
    const srcMatch = /src="([^"]+)"/.exec(domStr);
    const img = {
      hasAttribute: attr => attr === "src",
      getAttribute: attr => attr === "src" ? srcMatch?.[1] ?? null : null,
      closest: () => null,
    };
    const block = {
      getAttribute: attr => attr === "data-node-id" ? blockID : null,
      querySelector: () => null,
      querySelectorAll: sel => sel === "img" ? [img] : [],
    };
    return { img, block };
  };
  globalThis.document = {
    createElement: () => {
      let html = "";
      return {
        content: {
          get children() { return [makeNode(html).block]; },
        },
        set innerHTML(v) { html = v; },
      };
    },
  };

  const scope = new FeatureScope();
  try {
    const imgElement = {
      matches: () => true,
      closest: sel => sel === "[data-node-id]"
        ? { getAttribute: attr => attr === "data-node-id" ? blockID : null, querySelectorAll: () => [imgElement] }
        : null,
      hasAttribute: attr => attr === "src",
      getAttribute: attr => attr === "src" ? remoteURL : null,
    };

    const mockServices = {
      origin: "https://siyuan.test",
      userAgent: () => "OmniKit/Test",
      config: () => defaultImageFeatureConfig(),
      kernel: {
        post: async (url) => {
          if (url === "/api/block/getBlockDOM") {
            return { code: 0, data: { id: blockID, dom: currentDOM } };
          }
          throw new Error(`Unexpected ${url}`);
        },
      },
      reader: {
        read: async () => ({
          blob: new Blob([new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])], { type: "image/png" }),
          name: "test.png",
        }),
      },
      encoder: {
        encode: async () => ({
          kind: "encoded",
          value: {
            file: new File(["webp"], "test.webp", { type: "image/webp" }),
            originalBytes: 8,
            outputBytes: 4,
            width: 10,
            height: 10,
          },
        }),
      },
      assets: {
        upload: async (file) => file.name.endsWith(".webp") ? "assets/output.webp" : `assets/${file.name}`,
      },
      recordsReady: Promise.resolve(),
      records: {
        upsert: async (orig, comp) => { upserts.push({ orig, comp }); },
        markOperation: async (orig, comp, status) => { markOps.push({ orig, comp, status }); },
      },
      references: {
        commitOccurrence: async (target, newPath) => {
          commitCalls.push({ blockID: target.blockID, oldPath: target.oldPath, newPath });
          currentDOM = localizedDOM;
          return "replaced";
        },
      },
      ui: {
        manualCompression: (opts) => { dialogOptions = opts; },
        copyablePath: (path, key) => { copyPrompts.push({ path, key }); },
        notify: () => {},
      },
    };
    mockServices.savePreview = async (target, encodedFile, signal, replace) => {
      const { savePreview } = await import("../../../src/features/image-compressor/services/ImageProcessingServices.ts");
      return savePreview(mockServices, target, encodedFile, signal, replace);
    };

    await compressSelectedImageCustom(
      { element: imgElement },
      { plugin: { i18n: {} }, logger: { warn() {} } },
      scope,
      { rootID, notebook },
      mockServices,
    );

    const preview = await dialogOptions.previewEncode(0.8, 4096);
    assert.equal(commitCalls.length, 0);

    // Save with replace = false: MUST still localize remote image to assets/test.png,
    // re-read blockDOM (captured as localizedDOM), and save WebP record without replacing with WebP!
    await dialogOptions.save(preview, false);
    assert.equal(commitCalls.length, 1);
    assert.equal(commitCalls[0].oldPath, remoteURL);
    assert.equal(commitCalls[0].newPath, "assets/test.png");
    assert.equal(currentDOM, localizedDOM);
    assert.deepEqual(upserts, [
      { orig: remoteURL, comp: "assets/test.png" },
      { orig: "assets/test.png", comp: "assets/output.webp" },
    ]);
    assert.deepEqual(markOps, [
      { orig: remoteURL, comp: "assets/test.png", status: "replaced" },
    ]);
    assert.deepEqual(copyPrompts, [{ path: "assets/output.webp", key: "image.dialog.savedOnly" }]);
  } finally {
    scope.dispose();
    globalThis.document = priorDoc;
  }
});

test("compressSelectedImageQuick localizes remote URL through record persistence gate before compression", async () => {
  const { compressSelectedImageQuick } = await import("../../../src/features/image-compressor/actions/SingleImageAction.ts");
  const { compressOccurrence } = await import("../../../src/features/image-compressor/services/ImageProcessingServices.ts");

  const rootID = "20240101000000-abcdefg";
  const notebook = "20240101000000-hijklmn";
  const blockID = "20240101000000-opqrstu";
  const remoteURL = "https://example.com/quick.png";
  let currentDOM = `<div data-node-id="${blockID}"><img src="${remoteURL}"></div>`;
  const upserts = [];
  const markOps = [];
  const commitCalls = [];

  const priorDoc = globalThis.document;
  globalThis.document = {
    createElement: () => {
      let html = "";
      return {
        set innerHTML(v) { html = v; },
        get content() {
          const src = /src="([^"]+)"/.exec(html)?.[1] ?? null;
          const img = { hasAttribute: a => a === "src", getAttribute: a => a === "src" ? src : null, closest: () => null };
          const block = { getAttribute: a => a === "data-node-id" ? blockID : null, querySelector: () => null, querySelectorAll: s => s === "img" ? [img] : [] };
          return { children: [block] };
        },
      };
    },
  };

  const scope = new FeatureScope();
  try {
    const imgElement = {
      matches: () => true,
      closest: sel => sel === "[data-node-id]" ? { getAttribute: a => a === "data-node-id" ? blockID : null, querySelectorAll: () => [imgElement] } : null,
      hasAttribute: a => a === "src",
      getAttribute: a => a === "src" ? remoteURL : null,
    };
    const mockServices = {
      origin: "https://siyuan.test",
      userAgent: () => "OmniKit/Test",
      config: () => defaultImageFeatureConfig(),
      kernel: {
        post: async () => ({ code: 0, data: { id: blockID, dom: currentDOM } }),
      },
      reader: {
        read: async () => ({
          blob: new Blob([new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])], { type: "image/png" }),
          name: "quick.png",
        }),
      },
      encoder: {
        encode: async () => ({
          kind: "encoded",
          value: { file: new File(["webp"], "quick.webp", { type: "image/webp" }), width: 10, height: 10 },
        }),
      },
      assets: {
        upload: async file => file.name.endsWith(".webp") ? "assets/quick.webp" : "assets/quick.png",
      },
      recordsReady: Promise.resolve(),
      records: {
        upsert: async (orig, comp) => { upserts.push({ orig, comp }); },
        markOperation: async (orig, comp, status) => { markOps.push({ orig, comp, status }); },
      },
      references: {
        commitOccurrence: async (_target, newPath) => {
          commitCalls.push(newPath);
          currentDOM = `<div data-node-id="${blockID}"><img src="${newPath}"></div>`;
          return "replaced";
        },
      },
      ui: { copyablePath() {}, notify() {} },
    };
    mockServices.compressOccurrence = (t, cfg, sig, opts) => compressOccurrence(mockServices, t, cfg, sig, opts);

    const outcome = await compressSelectedImageQuick(
      { element: imgElement },
      { plugin: { i18n: {} }, logger: { warn() {}, debug() {} } },
      scope,
      { rootID, notebook },
      mockServices,
    );
    assert.equal(outcome?.key, "image.single.quickSuccess");
    assert.deepEqual(upserts, [
      { orig: remoteURL, comp: "assets/quick.png" },
      { orig: "assets/quick.png", comp: "assets/quick.webp" },
    ]);
    assert.deepEqual(markOps, [
      { orig: remoteURL, comp: "assets/quick.png", status: "replaced" },
      { orig: "assets/quick.png", comp: "assets/quick.webp", status: "replaced" },
    ]);
    assert.deepEqual(commitCalls, ["assets/quick.png", "assets/quick.webp"]);
  } finally {
    scope.dispose();
    globalThis.document = priorDoc;
  }
});

test("D02 + P1-3: remote localization unknown aborts WebP replacement and compressSelectedImageQuick reports image.single.unknown", async () => {
  const {
    compressSelectedImageCustom,
    compressSelectedImageQuick,
  } = await import("../../../src/features/image-compressor/actions/SingleImageAction.ts");

  const rootID = "20240101000000-abcdefg";
  const notebook = "20240101000000-hijklmn";
  const blockID = "20240101000000-opqrstu";
  const dom = `<div data-node-id="${blockID}"><img src="https://example.com/u.png"></div>`;

  const priorDoc = globalThis.document;
  const img = {
    hasAttribute: attr => attr === "src",
    getAttribute: attr => attr === "src" ? "https://example.com/u.png" : null,
    closest: () => null,
  };
  const block = {
    getAttribute: attr => attr === "data-node-id" ? blockID : null,
    querySelector: () => null,
    querySelectorAll: sel => sel === "img" ? [img] : [],
  };
  globalThis.document = {
    createElement: () => ({ content: { children: [block] }, set innerHTML(_) {} }),
  };

  const scope = new FeatureScope();
  try {
    const imgElement = {
      matches: () => true,
      closest: sel => sel === "[data-node-id]"
        ? { getAttribute: attr => attr === "data-node-id" ? blockID : null, querySelectorAll: () => [imgElement] }
        : null,
      hasAttribute: attr => attr === "src",
      getAttribute: attr => attr === "src" ? "https://example.com/u.png" : null,
    };

    let webpSaved = false;
    const copyPrompts = [];
    let dialogOptions;
    const mockServices = {
      origin: "https://siyuan.test",
      userAgent: () => "OmniKit/Test",
      config: () => defaultImageFeatureConfig(),
      kernel: {
        post: async () => ({ code: 0, data: { id: blockID, dom } }),
      },
      reader: {
        read: async () => ({
          blob: new Blob([new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])], { type: "image/png" }),
          name: "u.png",
        }),
      },
      encoder: {
        encode: async () => ({
          kind: "encoded",
          value: { file: new File(["webp"], "u.webp", { type: "image/webp" }), originalBytes: 8, outputBytes: 4, width: 10, height: 10 },
        }),
      },
      assets: { upload: async () => "assets/u.png" },
      recordsReady: Promise.resolve(),
      records: { upsert: async () => {}, markOperation: async () => {} },
      references: { commitOccurrence: async () => "unknown" },
      compressOccurrence: async () => ({ status: "saved", path: "assets/u.webp", reference: "unknown" }),
      savePreview: async () => { webpSaved = true; return { status: "saved", path: "assets/u.webp", reference: "replaced" }; },
      ui: {
        manualCompression: (opts) => { dialogOptions = opts; },
        copyablePath: (path, key) => { copyPrompts.push({ path, key }); },
        notify: () => {},
      },
    };

    await compressSelectedImageCustom(
      { element: imgElement },
      { plugin: { i18n: {} }, logger: { warn() {} } },
      scope,
      { rootID, notebook },
      mockServices,
    );
    const preview = await dialogOptions.previewEncode(0.8, 4096);
    await dialogOptions.save(preview, true);
    assert.equal(webpSaved, false);
    assert.deepEqual(copyPrompts, [{ path: "assets/u.png", key: "image.single.unknown" }]);

    // Quick mode on local asset returning reference === "unknown"
    const localImg = {
      matches: () => true,
      closest: sel => sel === "[data-node-id]"
        ? { getAttribute: attr => attr === "data-node-id" ? blockID : null, querySelectorAll: () => [localImg] }
        : null,
      hasAttribute: attr => attr === "src",
      getAttribute: attr => attr === "src" ? "assets/local.png" : null,
    };
    img.getAttribute = attr => attr === "src" ? "assets/local.png" : null;
    const quickOutcome = await compressSelectedImageQuick(
      { element: localImg },
      { plugin: { i18n: {} }, logger: { warn() {} } },
      scope,
      { rootID, notebook },
      mockServices,
    );
    assert.deepEqual(quickOutcome, { kind: "notify", key: "image.single.unknown" });

    // I-07: rejected localization / commitOccurrence reports image.single.failed
    mockServices.references.commitOccurrence = async () => "failed";
    const remoteImg = {
      matches: () => true,
      closest: sel => sel === "[data-node-id]"
        ? { getAttribute: attr => attr === "data-node-id" ? blockID : null, querySelectorAll: () => [remoteImg] }
        : null,
      hasAttribute: attr => attr === "src",
      getAttribute: attr => attr === "src" ? "https://example.com/u.png" : null,
    };
    img.getAttribute = attr => attr === "src" ? "https://example.com/u.png" : null;
    const failedOutcome = await compressSelectedImageQuick(
      { element: remoteImg },
      { plugin: { i18n: {} }, logger: { warn() {} } },
      scope,
      { rootID, notebook },
      mockServices,
    );
    assert.deepEqual(failedOutcome, { kind: "notify", key: "image.single.failed" });
  } finally {
    scope.dispose();
    globalThis.document = priorDoc;
  }
});

test("SingleImageAction rejects local file:// sources as image.single.unmappable in quick and custom modes", async () => {
  const {
    compressSelectedImageCustom,
    compressSelectedImageQuick,
  } = await import("../../../src/features/image-compressor/actions/SingleImageAction.ts");

  const rootID = "20240101000000-abcdefg";
  const notebook = "20240101000000-hijklmn";
  const blockID = "20240101000000-opqrstu";
  const fileURL = "file:///tmp/local.png";
  const dom = `<div data-node-id="${blockID}"><img src="${fileURL}"></div>`;

  const priorDoc = globalThis.document;
  const img = {
    hasAttribute: attr => attr === "src",
    getAttribute: attr => attr === "src" ? fileURL : null,
    closest: () => null,
  };
  const block = {
    getAttribute: attr => attr === "data-node-id" ? blockID : null,
    querySelector: () => null,
    querySelectorAll: sel => sel === "img" ? [img] : [],
  };
  globalThis.document = {
    createElement: () => ({ content: { children: [block] }, set innerHTML(_) {} }),
  };

  const scope = new FeatureScope();
  try {
    const imgElement = {
      matches: () => true,
      closest: sel => sel === "[data-node-id]"
        ? { getAttribute: attr => attr === "data-node-id" ? blockID : null, querySelectorAll: () => [imgElement] }
        : null,
      hasAttribute: attr => attr === "src",
      getAttribute: attr => attr === "src" ? fileURL : null,
    };
    let touchedDownstream = false;
    const mockServices = {
      origin: "https://siyuan.test",
      config: () => defaultImageFeatureConfig(),
      kernel: { post: async () => ({ code: 0, data: { id: blockID, dom } }) },
      reader: { read: async () => { touchedDownstream = true; throw new Error("must not read"); } },
      compressOccurrence: async () => { touchedDownstream = true; return { status: "skipped" }; },
      ui: { manualCompression: () => { touchedDownstream = true; } },
    };

    const quickOutcome = await compressSelectedImageQuick(
      { element: imgElement },
      { plugin: { i18n: {} }, logger: { warn() {}, debug() {} } },
      scope,
      { rootID, notebook },
      mockServices,
    );
    assert.deepEqual(quickOutcome, { kind: "notify", key: "image.single.unmappable" });

    const customOutcome = await compressSelectedImageCustom(
      { element: imgElement },
      { plugin: { i18n: {} }, logger: { warn() {}, debug() {} } },
      scope,
      { rootID, notebook },
      mockServices,
    );
    assert.deepEqual(customOutcome, { kind: "notify", key: "image.single.unmappable" });
    assert.equal(touchedDownstream, false);
  } finally {
    scope.dispose();
    globalThis.document = priorDoc;
  }
});

test("single-image quick and custom replace notifications format signed size-change percentage (-xx.x% / +xx.x%)", async () => {
  const { readFile } = await import("node:fs/promises");
  const { translate } = await import("../../../src/i18n/translate.ts");
  const { compressSelectedImageQuick, compressSelectedImageCustom } = await import("../../../src/features/image-compressor/actions/SingleImageAction.ts");
  const zh = JSON.parse(await readFile(new URL("../../../src/i18n/zh-CN.json", import.meta.url), "utf8"));
  const scope = new FeatureScope();
  const rootID = "20240101010101-abcdefg";
  const notebook = "20240101010101-box1234";
  const blockID = "20240101010101-blk1234";
  const assetPath = "assets/single-test.png";
  const dom = `<div data-node-id="${blockID}"><img src="${assetPath}"></div>`;

  const priorDoc = globalThis.document;
  globalThis.document = {
    createElement: () => ({
      innerHTML: "",
      content: {
        children: [{
          getAttribute: attr => attr === "data-node-id" ? blockID : null,
          querySelector: () => null,
          querySelectorAll: () => [{
            hasAttribute: attr => attr === "src",
            getAttribute: attr => attr === "src" ? assetPath : null,
          }],
        }],
      },
    }),
  };

  try {
    const imgElement = {
      matches: () => true,
      closest: sel => sel === "[data-node-id]"
        ? { getAttribute: attr => attr === "data-node-id" ? blockID : null, querySelectorAll: () => [imgElement] }
        : null,
      hasAttribute: attr => attr === "src",
      getAttribute: attr => attr === "src" ? assetPath : null,
    };

    const quickOutcome = await compressSelectedImageQuick(
      { element: imgElement },
      { plugin: { i18n: zh }, logger: { info() {}, warn() {}, debug() {} } },
      scope,
      { rootID, notebook },
      {
        origin: "https://siyuan.test",
        config: () => defaultImageFeatureConfig(),
        kernel: { post: async () => ({ code: 0, data: { id: blockID, dom } }) },
        compressOccurrence: async () => ({
          status: "saved",
          path: "assets/single-test.webp",
          reference: "replaced",
          originalBytes: 2048,
          compressedBytes: 512,
        }),
      },
    );
    assert.deepEqual(quickOutcome, {
      kind: "notify",
      key: "image.single.quickSuccess",
      values: { original: "2.0 KB", compressed: "512 B", ratio: "-75.0%" },
    });
    assert.equal(translate(zh, quickOutcome.key, quickOutcome.values), "图片压缩成功：2.0 KB → 512 B（-75.0%）");

    // Custom dialog with larger WebP allowed shows +20.0%
    const customNotices = [];
    let dialogCallbacks;
    const customPending = compressSelectedImageCustom(
      { element: imgElement },
      { plugin: { i18n: zh }, logger: { info() {}, warn() {}, debug() {} } },
      scope,
      { rootID, notebook },
      {
        origin: "https://siyuan.test",
        config: () => defaultImageFeatureConfig(),
        kernel: { post: async () => ({ code: 0, data: { id: blockID, dom } }) },
        savePreview: async (_target, _file, _signal, _replace, metrics) => ({
          status: "saved",
          path: "assets/single-larger.webp",
          reference: "replaced",
          originalBytes: metrics.originalBytes,
          compressedBytes: metrics.compressedBytes,
        }),
        ui: {
          manualCompression: opts => { dialogCallbacks = opts; },
          notify: msg => customNotices.push(msg),
          copyablePath() {},
        },
      },
    );
    for (let i = 0; i < 10 && !dialogCallbacks; i++) await new Promise(r => setTimeout(r, 2));
    await dialogCallbacks.save({
      file: new File([new Uint8Array(1200)], "single-larger.webp", { type: "image/webp" }),
      originalBlob: new Blob([new Uint8Array(1000)], { type: "image/png" }),
      originalBytes: 1000,
      compressedBytes: 1200,
      width: 10,
      height: 10,
    }, true);
    dialogCallbacks.onClose();
    await customPending;
    assert.deepEqual(customNotices, ["图片压缩成功：1000 B → 1.2 KB（+20.0%）"]);

    // RecordPersistenceError from persistMappedAsset must not emit duplicate failed/saveFailed errors
    const { RecordPersistenceError } = await import("../../../src/features/image-compressor/services/ImageProcessingServices.ts");
    const quickPersistOutcome = await compressSelectedImageQuick(
      { element: imgElement },
      { plugin: { i18n: zh }, logger: { info() {}, warn() {}, debug() {} } },
      scope,
      { rootID, notebook },
      {
        origin: "https://siyuan.test",
        config: () => defaultImageFeatureConfig(),
        kernel: { post: async () => ({ code: 0, data: { id: blockID, dom } }) },
        compressOccurrence: async () => { throw new RecordPersistenceError("assets/orphan.webp", new Error("disk full")); },
      },
    );
    assert.deepEqual(quickPersistOutcome, { kind: "silent" });

    let customPersistDialog;
    const customPersistPending = compressSelectedImageCustom(
      { element: imgElement },
      { plugin: { i18n: zh }, logger: { info() {}, warn() {}, debug() {} } },
      scope,
      { rootID, notebook },
      {
        origin: "https://siyuan.test",
        config: () => defaultImageFeatureConfig(),
        kernel: { post: async () => ({ code: 0, data: { id: blockID, dom } }) },
        savePreview: async () => { throw new RecordPersistenceError("assets/orphan.webp", new Error("disk full")); },
        ui: {
          manualCompression: opts => { customPersistDialog = opts; },
          notify() {},
          copyablePath() {},
        },
      },
    );
    for (let i = 0; i < 10 && !customPersistDialog; i++) await new Promise(r => setTimeout(r, 2));
    // Must resolve without throwing so ImageTaskUI closes dialog cleanly without showing saveFailed
    await customPersistDialog.save({
      file: new File([new Uint8Array(600)], "orphan.webp", { type: "image/webp" }),
      originalBlob: new Blob([new Uint8Array(1000)], { type: "image/png" }),
      originalBytes: 1000,
      compressedBytes: 600,
      width: 10,
      height: 10,
    }, true);
    customPersistDialog.onClose();
    await customPersistPending;
  } finally {
    scope.dispose();
    globalThis.document = priorDoc;
  }
});
