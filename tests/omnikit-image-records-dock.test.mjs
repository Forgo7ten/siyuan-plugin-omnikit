import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const dockPath = new URL("../src/features/image-compressor/ImageRecordsDock.svelte", import.meta.url);
const registrationPath = new URL("../src/features/image-compressor/registration.ts", import.meta.url);
const zhJsonPath = new URL("../src/i18n/zh-CN.json", import.meta.url);
const enJsonPath = new URL("../src/i18n/en.json", import.meta.url);

test("image records dock shares the feature record store and is registered as its dock view", async () => {
  const [dock, registration] = await Promise.all([
    readFile(dockPath, "utf8"),
    readFile(registrationPath, "utf8"),
  ]);

  assert.match(dock, /imageRecordsFor\(context\.plugin\)/);
  assert.match(registration, /import ImageRecordsDock from "\.\/ImageRecordsDock\.svelte"/);
  assert.match(registration, /dockView:\s*ImageRecordsDock/);
  assert.match(dock, /store\.snapshot\(\)/);
  assert.match(dock, /store\.store\.subscribe\(/);
  assert.match(dock, /store\.removeRecord\(record\.originalPath\)/);
});

test("dock lookups are user-triggered and restore is occurrence-scoped with persisted identity checks", async () => {
  const dock = await readFile(dockPath, "utf8");

  assert.match(dock, /onclick=\{\(\) => toggleOriginalReferences\(record\)\}/);
  assert.match(dock, /onclick=\{\(\) => locateRestoreOccurrences\(record\)\}/);
  assert.match(dock, /\/api\/asset\/findAssetReferences/);
  assert.match(dock, /\/api\/block\/getBlockInfo/);
  assert.match(dock, /\/api\/block\/getBlockDOM/);
  assert.match(dock, /info\?\.rootID !== row\.rootID \|\| info\.box !== row\.notebook/);
  assert.match(dock, /references\.commitOccurrence\(item\.target, record\.originalPath(?:,\s*context\.scope\?\.signal)?\)/);
  assert.match(dock, /\/api\/asset\/statAsset/);
  assert.match(dock, /openTab\(/);
  assert.match(dock, /jumpToBlock\(/);
  assert.match(dock, /image\.records\.replaceThis/);
  assert.match(dock, /image\.records\.replaceAll/);
  assert.match(dock, /image\.records\.restoreThis/);
  assert.match(dock, /image\.records\.restoreAll/);
  assert.match(dock, /image\.records\.noOriginalReferences/);
  assert.match(dock, /image\.records\.noCompressedReferences/);
  assert.match(dock, /assetStatuses\[record\.originalPath\] = "unknown"/);
  assert.match(dock, /copyPath\(record\.originalPath\)/);
  assert.match(dock, /copyPath\(record\.compressedPath\)/);
  assert.match(dock, /navigator\.clipboard\.writeText/);
  assert.match(dock, /image\.records\.originalStatus/);
  assert.match(dock, /image\.records\.compressedStatus/);
  assert.match(dock, /origStatus === "missing" \|\| compStatus === "missing"/);
  assert.match(dock, /omnikit-dock-tab-activated/);
  assert.doesNotMatch(dock, /relinkAsset|\/api\/asset\/removeAsset|removeAsset\(/);
  assert.doesNotMatch(dock, /noSafeOccurrences/);
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

  // locateOccurrences signature with source defaulting to user_click
  assert.match(dock, /async function locateOccurrences\(\s*record:\s*CompressionRecord,\s*mode:\s*"original"\s*\|\s*"compressed",\s*source:\s*"user_click"\s*\|\s*"post_action"\s*=\s*"user_click"\s*\)/);

  // user_click only resets message at start
  assert.match(dock, /if\s*\(source === "user_click"\)\s*\{\s*message = "";\s*\}/);

  // user_click sets contextual message on empty occurrences
  assert.match(dock, /if\s*\(source === "user_click"\)\s*\{\s*if\s*\(!targets\.length\)\s*\{\s*message = mode === "original"\s*\?\s*t\("image\.records\.noOriginalReferences"\)\s*:\s*t\("image\.records\.noCompressedReferences"\);/);

  // post_action preserves action message and auto-collapses expanded drawer when empty (Option B)
  assert.match(dock, /else\s*\{\s*if\s*\(!targets\.length\)\s*\{\s*expanded = null;\s*occurrences = \[\];\s*\}\s*\}/);

  // Single and bulk actions invoke locateOccurrences with post_action
  assert.match(dock, /await locateOccurrences\(record, "original", "post_action"\)/);
  assert.match(dock, /await locateOccurrences\(record, "compressed", "post_action"\)/);

  // Reference buttons invoke locateOccurrences with user_click
  assert.match(dock, /await locateOccurrences\(record, "original", "user_click"\)/);
  assert.match(dock, /await locateOccurrences\(record, "compressed", "user_click"\)/);

  // Template renders contextual empty text based on expanded mode
  assert.match(dock, /\{expanded\?\.mode === "original"\s*\?\s*t\("image\.records\.noOriginalReferences"\)\s*:\s*t\("image\.records\.noCompressedReferences"\)\}/);
  assert.doesNotMatch(dock, /noSafeOccurrences/);
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
