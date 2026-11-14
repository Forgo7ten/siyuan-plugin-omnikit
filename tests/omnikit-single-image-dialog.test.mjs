import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const read = path => readFile(new URL(path, import.meta.url), "utf8");

test("image context menu exposes only quick and custom compression actions", async () => {
  const menu = await read("../src/features/image-compressor/menuContributions.ts");
  assert.match(menu, /id: "compress-image-quick"/);
  assert.match(menu, /id: "compress-image-custom"/);
  assert.match(menu, /label:\s*deps\.t\("menu\.compressImageQuick"\)/);
  assert.match(menu, /label:\s*deps\.t\("menu\.compressImageCustom"\)/);
  assert.doesNotMatch(menu, /compress-image-from-file|compressFromFile|pickImage/);
  assert.doesNotMatch(menu, /`\[OmniKit\] \$\{value\}`/);
});

test("quick compression targets one occurrence and uses manual quick mode", async () => {
  const action = await read("../src/features/image-compressor/SingleImageAction.ts");
  assert.match(action, /resolveSelectedOccurrence\(menuDetail, editor, services, signal\)/);
  assert.match(action, /services\.compressOccurrence\(target, services\.config\(\), signal, \{\s*replace: true,\s*mode: "manual-quick"/);
  assert.match(action, /services\.references\.commitOccurrence\(target, localPath, signal\)/);
});

test("manual compression previews in memory and saves only through savePreview", async () => {
  const action = await read("../src/features/image-compressor/SingleImageAction.ts");
  const ui = await read("../src/features/image-compressor/ImageTaskUI.ts");
  const component = await read("../src/features/image-compressor/ImageCompressionDialog.svelte");
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
