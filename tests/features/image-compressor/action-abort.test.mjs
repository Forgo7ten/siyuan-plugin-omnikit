import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const read = path => readFile(new URL(path, import.meta.url), "utf8");

test("SingleImageAction separates quiet cancellation from error handling", async () => {
  const action = await read("../../../src/features/image-compressor/actions/SingleImageAction.ts");

  // In quick action: abort check returns silently before invalidTarget and unmappable, returning ImageActionOutcome
  assert.match(action, /const signal = scope\.signal;\s*if \(!scope\.active \|\| signal\.aborted\) return;\s*if \(editor\.disabled\) return \{ kind: "notify", key: "image\.single\.invalidTarget" \};/);
  assert.match(action, /let target = await resolveSelectedOccurrence\(menuDetail, editor, services, signal\);\s*if \(!scope\.active \|\| signal\.aborted\) return;\s*if \(!target\) return \{ kind: "notify", key: "image\.single\.unmappable" \};/);

  // In custom action: abort check returns silently before invalidTarget and unmappable, and catch returns failed outcome
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
  assert.doesNotMatch(batch, /sliceImageBlockDOMs|resolveImageOccurrence/);
  assert.doesNotMatch(batch, /WHERE type = 'p'/);
  assert.doesNotMatch(batch, /mode:\s*["']write["']/);
  assert.doesNotMatch(batch, /getBlockDOMs/);
});

test("RemoteImageWatcher guards against unauthorized documents before taking snapshot or HTTP calls", async () => {
  const watcher = await read("../../../src/features/image-compressor/actions/RemoteImageWatcher.ts");

  // Entry guard in watchRemoteImages before initial snapshot
  assert.match(watcher, /if \(autoAllowed\(services\.config\(\), doc\.id\)\) \{\s*try \{\s*previous = await snapshot\(\);/);

  // Entry guard in sweep() before snapshot
  assert.match(watcher, /async function sweep\([^)]*\): Promise<void> \{\s*if \([\s\S]*?\) return;\s*if \(!autoAllowed\(services\.config\(\), doc\.id\)\) return;\s*if \(reading\)/);
});

test("ImageController guards inactive scope and auto-closes progress modal on zero scanned images", async () => {
  const controller = await read("../../../src/features/image-compressor/ImageController.ts");
  const feature = await read("../../../src/features/image-compressor/ImageCompressorFeature.ts");

  // Inactive scope guards in ImageController
  assert.match(controller, /async compressSingleQuick\([\s\S]*?\)(?::\s*Promise<void>)?\s*\{\s*if \(!this\.scope\.active\) return;/);
  assert.match(controller, /async compressSingleCustom\([\s\S]*?\)(?::\s*Promise<void>)?\s*\{\s*if \(!this\.scope\.active\) return;/);
  assert.match(controller, /async compressDocument\([\s\S]*?\)(?::\s*Promise<void>)?\s*\{\s*if \(!this\.scope\.active\) return;/);

  // Distinguishes cancelled, zero scanned images (noImages), and incomplete scan (scanFailed)
  assert.match(controller, /if \(result\.cancelled\) \{\s*view\.close\(\);\s*return;\s*\}/);
  assert.match(controller, /if \(result\.total === 0 && result\.scanComplete\) \{\s*view\.close\(\);[\s\S]*?"image\.batch\.noImages"/);
  assert.match(controller, /if \(!result\.scanComplete\) \{[\s\S]*?"image\.batch\.scanFailed"/);

  // Duplicate cancelAll removed in ImageCompressorFeature
  assert.doesNotMatch(feature, /protected onDisable\(\): void \{\s*this\.tasks\.cancelAll\("Feature disabled"\);\s*\}/);

  // activeDocuments tracking prevents duplicate concurrent batches on the same document
  assert.match(controller, /activeDocuments\.has\(rootID\)/);
  assert.match(controller, /activeDocuments\.add\(rootID\)/);
  assert.match(controller, /activeDocuments\.delete\(rootID\)/);

  // modal dismissal and editor switch trigger abort
  assert.match(controller, /modalAbortController\.abort\(new DOMException\("Task modal dismissed", "AbortError"\)\)/);
  assert.match(controller, /modalAbortController\.abort\(new DOMException\("Editor switched", "AbortError"\)\)/);
});

test("ImageCompressorFeature.toggleDocument passes scope.signal and guards scope after path lookups", async () => {
  const feature = await read("../../../src/features/image-compressor/ImageCompressorFeature.ts");

  assert.match(feature, /resolveDocument\(menu\.rootID, ctx\.logger, notebookId, scope\.signal\)/);
  assert.match(feature, /\/api\/filetree\/getFullHPathByID",\s*\{\s*id:\s*menu\.rootID\s*\},\s*\{\s*signal:\s*scope\.signal\s*\}/);
  assert.match(feature, /\/api\/filetree\/getHPathByID",\s*\{\s*id:\s*menu\.rootID\s*\},\s*\{\s*signal:\s*scope\.signal\s*\}/);
  assert.match(feature, /if \(!scope\.active \|\| scope\.signal\.aborted\) return;\s*const enabled = await this\.pages\.toggle/);
});
