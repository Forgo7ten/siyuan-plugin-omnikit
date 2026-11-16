import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const read = path => readFile(new URL(path, import.meta.url), "utf8");

test("SingleImageAction separates quiet cancellation from error handling", async () => {
  const action = await read("../../../src/features/image-compressor/actions/SingleImageAction.ts");

  // In quick action: abort check returns silently before invalidTarget and unmappable
  assert.match(action, /const signal = scope\.signal;\s*if \(!scope\.active \|\| signal\.aborted\) return;\s*if \(editor\.disabled\) return notify/);
  assert.match(action, /let target = await resolveSelectedOccurrence\(menuDetail, editor, services, signal\);\s*if \(!scope\.active \|\| signal\.aborted\) return;\s*if \(!target\) return notify\(context, services, "image\.single\.unmappable"\);/);

  // In custom action: abort check returns silently before invalidTarget and unmappable
  assert.match(action, /const target = await resolveSelectedOccurrence\(menuDetail, editor, services, signal\);\s*if \(!scope\.active \|\| signal\.aborted\) return;\s*if \(!target\) return notify\(context, services, "image\.single\.unmappable"\);/);
});

test("DocumentBatchAction returns cancelled quietly without showing invalidDocument toast on abort", async () => {
  const batch = await read("../../../src/features/image-compressor/actions/DocumentBatchAction.ts");

  // Checks abort first and returns cancelledSummary without showMessage("image.batch.invalidDocument")
  assert.match(batch, /if \(signal\.aborted \|\| !scope\.active\) \{\s*return cancelledSummary\(summary\);\s*\}\s*if \(!rootID \|\| protyle\?\.disabled\) \{\s*showMessage\(translate\(context\.plugin\.i18n, "image\.batch\.invalidDocument"\), 5000\);/);
});

test("RemoteImageWatcher guards against unauthorized documents before taking snapshot or HTTP calls", async () => {
  const watcher = await read("../../../src/features/image-compressor/actions/RemoteImageWatcher.ts");

  // Entry guard in watchRemoteImages before initial snapshot
  assert.match(watcher, /if \(autoAllowed\(services\.config\(\), doc\.id\)\) \{\s*try \{\s*previous = await snapshot\(\);/);

  // Entry guard in sweep() before snapshot
  assert.match(watcher, /async function sweep\(\): Promise<void> \{\s*if \([\s\S]*?\) return;\s*if \(!autoAllowed\(services\.config\(\), doc\.id\)\) return;\s*if \(reading\)/);
});

test("ImageController guards inactive scope and auto-closes progress modal on zero scanned images", async () => {
  const controller = await read("../../../src/features/image-compressor/ImageController.ts");
  const feature = await read("../../../src/features/image-compressor/ImageCompressorFeature.ts");

  // Inactive scope guards in ImageController
  assert.match(controller, /async compressSingleQuick\([\s\S]*?\)(?::\s*Promise<void>)?\s*\{\s*if \(!this\.scope\.active\) return;/);
  assert.match(controller, /async compressSingleCustom\([\s\S]*?\)(?::\s*Promise<void>)?\s*\{\s*if \(!this\.scope\.active\) return;/);
  assert.match(controller, /async compressDocument\([\s\S]*?\)(?::\s*Promise<void>)?\s*\{\s*if \(!this\.scope\.active\) return;/);

  // Auto-close modal when scanned result has zero images
  assert.match(controller, /if \(result\.total === 0\) \{\s*view\.close\(\);\s*return;\s*\}/);

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
