import { test } from "node:test";
import assert from "node:assert/strict";
import { compressOccurrence, RecordPersistenceError } from "../src/features/image-compressor/ImageProcessingServices.ts";
import { defaultImageFeatureConfig } from "../src/features/image-compressor/parseImageConfig.ts";

const target = {
  rootID: "20250101000000-abcdefg",
  notebook: "20250101000000-hijklmn",
  blockID: "20250101000000-opqrstu",
  imageOrdinal: 0,
  oldPath: "assets/original.png",
  baselineBlockDOM: '<div data-node-id="20250101000000-opqrstu"><img src="assets/original.png"></div>',
};

function services(saveRecord) {
  const calls = [];
  const original = new Blob(["original"], { type: "image/png" });
  const webp = new File(["webp"], "image.webp", { type: "image/webp" });
  const service = {
    origin: "http://localhost:6806",
    userAgent: () => "OmniKit/Test",
    reader: { async read(source) {
      calls.push(`read:${source.path}`);
      return { blob: source.path === "assets/original.png" ? original : webp, name: "original.png" };
    } },
    encoder: { async encode() { calls.push("encode"); return { kind: "encoded", value: { file: webp } }; } },
    assets: { async upload() { calls.push("upload"); return "assets/output.webp"; } },
    recordsReady: Promise.resolve(),
    records: {
      async upsert() { calls.push("record"); await saveRecord(); },
      async markOperation() { calls.push("status"); },
    },
    references: { async commitOccurrence() { calls.push("updateBlock"); return "replaced"; } },
    ui: { copyablePath(path) { calls.push(`copy:${path}`); } },
  };
  return { service, calls };
}

test("failed record persistence blocks block update and exposes uploaded WebP path", async () => {
  const { service, calls } = services(() => { throw new Error("disk full"); });
  await assert.rejects(compressOccurrence(service, target, defaultImageFeatureConfig(), new AbortController().signal,
    { replace: true }), error => error instanceof RecordPersistenceError && error.uploadedPath === "assets/output.webp");
  assert.deepEqual(calls.slice(-2), ["record", "copy:assets/output.webp"]);
  assert.equal(calls.includes("updateBlock"), false);
});

test("confirmed record write precedes occurrence update", async () => {
  const { service, calls } = services(() => undefined);
  const result = await compressOccurrence(service, target, defaultImageFeatureConfig(), new AbortController().signal,
    { replace: true });
  assert.deepEqual(result, { status: "saved", path: "assets/output.webp", reference: "replaced", originalBytes: 8, compressedBytes: 4 });
  assert.ok(calls.indexOf("record") < calls.indexOf("updateBlock"));
});
