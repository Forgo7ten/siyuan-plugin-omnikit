import { test } from "node:test";
import assert from "node:assert/strict";
import { compressOccurrence, RecordPersistenceError, savePreview } from "../../../src/features/image-compressor/services/ImageProcessingServices.ts";
import { defaultImageFeatureConfig } from "../../../src/features/image-compressor/policy/parseImageConfig.ts";

const target = {
  rootID: "20250101000000-abcdefg",
  notebook: "20250101000000-hijklmn",
  blockID: "20250101000000-opqrstu",
  imageOrdinal: 0,
  oldPath: "assets/original.png",
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

test("savePreview(..., false) normalizes relative asset path and exposes uploaded path without capacity key on failure", async () => {
  const copyCalls = [];
  const upserts = [];
  const service = {
    origin: "http://localhost:6806",
    assets: { async upload() { return "assets/output.webp"; } },
    recordsReady: Promise.resolve(),
    records: {
      async upsert(orig, comp) {
        upserts.push([orig, comp]);
        throw new Error("write failed");
      },
    },
    ui: { copyablePath(path, key) { copyCalls.push({ path, key }); } },
  };
  const webp = new File(["webp"], "image.webp", { type: "image/webp" });
  await assert.rejects(
    savePreview(service, { ...target, oldPath: "./assets/original.png" }, webp, new AbortController().signal, false),
    error => error instanceof RecordPersistenceError && error.uploadedPath === "assets/output.webp",
  );
  assert.deepEqual(upserts, [["assets/original.png", "assets/output.webp"]]);
  assert.deepEqual(copyCalls, [{ path: "assets/output.webp", key: undefined }]);
});

test("finishSaved classifies pre-write abort as aborted without marking saved-only record incomplete", async () => {
  const controller = new AbortController();
  const markCalls = [];
  let commitCalls = 0;
  const original = new Blob(["original"], { type: "image/png" });
  const webp = new File(["webp"], "image.webp", { type: "image/webp" });
  const service = {
    origin: "http://localhost:6806",
    userAgent: () => "OmniKit/Test",
    reader: { async read() { return { blob: original, name: "original.png" }; } },
    encoder: { async encode() { return { kind: "encoded", value: { file: webp } }; } },
    assets: { async upload() { return "assets/output.webp"; } },
    recordsReady: Promise.resolve(),
    records: {
      async upsert() {
        // Abort happens during/right after record persistence, before commitOccurrence runs
        controller.abort();
      },
      async markOperation(orig, comp, status) {
        markCalls.push({ orig, comp, status });
      },
    },
    references: {
      async commitOccurrence() {
        commitCalls += 1;
        return "replaced";
      },
    },
    ui: { copyablePath() {} },
  };

  const result = await compressOccurrence(service, target, defaultImageFeatureConfig(), controller.signal, { replace: true });
  assert.equal(result.status, "saved");
  assert.equal(result.reference, "aborted");
  assert.equal(commitCalls, 0);
  assert.deepEqual(markCalls, []);

  // Also verify savePreview path preserves aborted without calling markOperation
  const controller2 = new AbortController();
  service.records.upsert = async () => { controller2.abort(); };
  const previewResult = await savePreview(service, target, webp, controller2.signal, true);
  assert.equal(previewResult.status, "saved");
  assert.equal(previewResult.reference, "aborted");
  assert.equal(commitCalls, 0);
  assert.deepEqual(markCalls, []);
});
