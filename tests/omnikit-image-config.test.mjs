import { test } from "node:test";
import assert from "node:assert/strict";
import { defaultImageFeatureConfig, parseImageConfig, parseExtensions } from "../src/features/image-compressor/parseImageConfig.ts";
import { featureConfigFile, featureDataFile, isFeatureDataFile, validateFeatureFiles } from "../src/core/FeatureRegistration.ts";

const valid = () => defaultImageFeatureConfig();
const rootID = "20250101000000-abcdefg";
const rejects = (mutate, label) => {
  const config = valid();
  mutate(config);
  assert.throws(() => parseImageConfig(config), undefined, label);
};

test("image defaults use schema 2 and the grouped configuration shape", () => {
  const config = valid();
  assert.equal(config.schemaVersion, 2);
  assert.equal(config.compression.smartEnabled, false);
  assert.equal(config.compression.targetSimilarity, 0.99);
  assert.deepEqual(parseImageConfig(config), config);
});

test("migrates schemaVersion 1 config to schemaVersion 2", () => {
  const v1 = {
    schemaVersion: 1,
    auto: { globalEnabled: false, pageAllowlist: {} },
    compression: {
      initialQuality: 0.8,
      manualMaxEdge: 4096,
      minInputBytes: 102400,
      minSavingBytes: 4096,
      minSavingRatio: 0.05,
      maxInputBytes: 33554432,
      maxPixels: 32000000,
      maxEncodeMs: 45000,
      concurrencyDesktop: 2,
      concurrencyMobile: 1,
      excludedExtensions: ["gif", "svg", "webp"],
    },
    metadata: { preserveExif: false },
    sources: { desktopLocalFiles: true },
    references: { backend: "auto", maxDocuments: 10000 },
  };
  const parsed = parseImageConfig(v1);
  assert.equal(parsed.schemaVersion, 2);
  assert.equal(parsed.compression.smartEnabled, false);
  assert.equal(parsed.compression.targetSimilarity, 0.99);
});

test("validates smartEnabled and targetSimilarity bounds", () => {
  const config = valid();
  config.compression.smartEnabled = true;
  config.compression.targetSimilarity = 0.95;
  assert.deepEqual(parseImageConfig(config), config);

  rejects(c => { c.compression.smartEnabled = "true"; }, "smartEnabled type");
  rejects(c => { c.compression.targetSimilarity = 0.899; }, "targetSimilarity lower bound");
  rejects(c => { c.compression.targetSimilarity = 1.0; }, "targetSimilarity upper bound");
});

test("image config validates complete grouped settings and document permissions", () => {
  const config = valid();
  config.auto.pageAllowlist[rootID] = { grantedAt: 0, title: "" };
  config.compression.manualMaxEdge = 8192;
  assert.deepEqual(parseImageConfig(config), config);
  for (const id of ["20250101000000-ABCDEFG", "20250101000000-abcdefg_", "2025010100000-abcdefg"]) {
    rejects(c => { c.auto.pageAllowlist[id] = { grantedAt: 1, title: "" }; }, id);
  }
  rejects(c => { c.auto.pageAllowlist[rootID] = { grantedAt: -1, title: "" }; }, "negative timestamp");
  rejects(c => { c.auto.pageAllowlist[rootID] = { grantedAt: 1, title: 7 }; }, "title type");
});

test("compression options enforce numeric bounds and complete schema", () => {
  for (const value of [0.009, 1.01]) rejects(c => { c.compression.initialQuality = value; }, `quality ${value}`);
  for (const value of [512.5, 511, 16385]) rejects(c => { c.compression.manualMaxEdge = value; }, `dimension ${value}`);
  rejects(c => { c.metadata.preserveExif = true; }, "EXIF unsupported");
});

test("legacy config with remote downloadUserAgent is safely parsed and silently discarded", () => {
  const legacy = {
    ...valid(),
    remote: { downloadUserAgent: "CustomUA/1.0" },
  };
  const parsed = parseImageConfig(legacy);
  assert.equal(parsed.schemaVersion, 2);
  assert.equal("remote" in parsed, false);
  assert.deepEqual(parsed, valid());
});

test("extension lists are normalized and validated", () => {
  const config = valid();
  config.compression.excludedExtensions = ["gif", "gif"];
  assert.deepEqual(parseImageConfig(config).compression.excludedExtensions, ["gif"]);
  assert.deepEqual(parseExtensions(".GIF, svg，gif"), ["gif", "svg"]);
  assert.throws(() => parseExtensions("bad extension"));
});

test("feature settings and data derive isolated stable names", () => {
  assert.equal(featureConfigFile("imageCompressor"), "feature-image-compressor-settings.json");
  assert.equal(featureDataFile("imageCompressor", "records"), "feature-image-compressor-records.json");
  assert.equal(isFeatureDataFile("imageCompressor", "records", "feature-image-compressor-records.json"), true);
  assert.equal(isFeatureDataFile("imageCompressor", "records", featureConfigFile("imageCompressor")), false);
  assert.throws(() => featureDataFile("imageCompressor", "settings"));
  assert.throws(() => featureDataFile("imageCompressor", "../records"));
  assert.throws(() => featureConfigFile("-invalid"));
  assert.throws(() => validateFeatureFiles(["imageCompressor", "imageCompressor"]));
  assert.throws(() => validateFeatureFiles(["aBC", "aBc"]));
});

test("rejects unsupported schemaVersion", () => {
  const unknown = valid();
  unknown.schemaVersion = 3;
  assert.throws(() => parseImageConfig(unknown));
});
