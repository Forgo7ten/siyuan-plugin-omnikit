import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

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

test("manual compression previews in memory and saves only through savePreview", async () => {
  const action = await read("../../../src/features/image-compressor/actions/SingleImageAction.ts");
  const ui = await read("../../../src/features/image-compressor/ui/ImageTaskUI.ts");
  const component = await read("../../../src/features/image-compressor/ui/ImageCompressionDialog.svelte");
  assert.match(action, /services\.encoder\.encode\([\s\S]*?"manual-dialog"\)/);
  assert.match(action, /services\.savePreview\(localizedTarget, preview\.file, signal, replace\)/);
  assert.match(action, /previewOriginal = original/);
  const customAction = action.slice(action.indexOf("export async function compressSelectedImageCustom"), action.indexOf("async function localizeRemoteOccurrence"));
  const opening = customAction.slice(0, customAction.indexOf("save: async"));
  assert.doesNotMatch(opening, /assets\.upload|records\.upsert|references\.commitOccurrence|savePreview/);
  assert.match(customAction, /onClose = \(\) => \{\s*signal\.removeEventListener\("abort", relayAbort\);\s*previewAbort\.abort/);
  assert.match(ui, /manualCompression\(options\)/);
  assert.doesNotMatch(ui, /pickImage/);
  assert.match(component, /let replaceCurrent = \$state\(false\)/);
  assert.match(component, /URL\.createObjectURL\(encoded\.file\)/);
  assert.match(component, /URL\.revokeObjectURL\(previewURL\)/);
  assert.doesNotMatch(component, /window\.confirm|>\s*取消\s*</);
});

test("savePreview with replace: false generates asset and record with zero updateBlock calls", async () => {
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
  assert.equal(updateBlockCalls, 0); // Strictly zero updateBlock calls
});

test("localizeRemoteOccurrence with replace: false uploads remote asset without updateBlock", async () => {
  const { localizeRemoteOccurrence } = await import("../../../src/features/image-compressor/actions/SingleImageAction.ts");
  const { savePreview } = await import("../../../src/features/image-compressor/services/ImageProcessingServices.ts");

  let updateBlockCalls = 0;
  let recordUpsertCalls = 0;
  let uploadCalls = 0;

  const mockServices = {
    origin: "https://siyuan.test",
    userAgent: () => "OmniKit/Test",
    config: () => ({ compression: { maxInputBytes: 10 * 1024 * 1024 } }),
    reader: {
      read: async () => ({
        blob: new Blob([new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])], { type: "image/png" }),
        name: "test.png",
      }),
    },
    assets: {
      upload: async (file) => {
        uploadCalls++;
        return `assets/${file.name}`;
      },
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
      notify: () => {},
    },
  };

  const remoteTarget = {
    rootID: "20240101000000-abcdefg",
    notebook: "20240101000000-hijklmn",
    blockID: "20240101000000-opqrstu",
    imageOrdinal: 0,
    oldPath: "https://example.com/test.png",
    baselineBlockDOM: '<div data-node-id="20240101000000-opqrstu"><img src="https://example.com/test.png"></div>',
  };

  const signal = new AbortController().signal;

  // 1. Localize with replace: false
  const localizedTarget = await localizeRemoteOccurrence(remoteTarget, mockServices, signal, false);
  assert.equal(localizedTarget.oldPath, "assets/test.png");
  assert.equal(uploadCalls, 1); // uploaded remote original to assets
  assert.equal(updateBlockCalls, 0); // Strictly zero document writes during localization

  // 2. Save preview with replace: false
  const webpFile = new File(["dummy-webp"], "output.webp", { type: "image/webp" });
  const result = await savePreview(mockServices, localizedTarget, webpFile, signal, false);

  assert.equal(result.status, "saved");
  assert.equal(result.reference, "not-requested");
  assert.equal(uploadCalls, 2); // uploaded original + webp
  assert.equal(recordUpsertCalls, 1); // record saved for assets/test.png -> assets/output.webp
  assert.equal(updateBlockCalls, 0); // Strictly zero document writes end-to-end
});
