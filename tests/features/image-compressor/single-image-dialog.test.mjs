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
    baselineBlockDOM: '<div data-node-id="20240101000000-opqrstu"><img src="assets/original.png"></div>',
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
        markOperation: async () => {},
      },
      references: {
        commitOccurrence: async (target, newPath) => {
          commitCalls.push({ baseline: target.baselineBlockDOM, oldPath: target.oldPath, newPath });
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
    assert.deepEqual(upserts, [{ orig: "assets/test.png", comp: "assets/output.webp" }]);
    assert.deepEqual(copyPrompts, [{ path: "assets/output.webp", key: "image.dialog.savedOnly" }]);
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
  } finally {
    scope.dispose();
    globalThis.document = priorDoc;
  }
});
