import { test } from "node:test";
import assert from "node:assert/strict";
import { defaultImageFeatureConfig, parseImageConfig } from "../../../src/features/image-compressor/policy/parseImageConfig.ts";
import { featureConfigFile, featureDataFile, isFeatureDataFile, validateFeatureFiles } from "../../../src/core/framework/FeatureRegistration.ts";

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
  assert.equal(config.compression.concurrencyDesktop, 3);
  assert.equal("concurrencyMobile" in config.compression, false);
  assert.equal("sources" in config, false);
  assert.equal("references" in config, false);
  assert.deepEqual(parseImageConfig(config), config);
});

test("validates smartEnabled and targetSimilarity strictly without fallback defaults", () => {
  const config = valid();
  config.compression.smartEnabled = true;
  config.compression.targetSimilarity = 0.95;
  assert.deepEqual(parseImageConfig(config), config);

  rejects(c => { delete c.compression.smartEnabled; }, "missing smartEnabled");
  rejects(c => { delete c.compression.targetSimilarity; }, "missing targetSimilarity");
  rejects(c => { c.compression.smartEnabled = "true"; }, "smartEnabled type");
  rejects(c => { c.compression.targetSimilarity = 0.899; }, "targetSimilarity lower bound");
  rejects(c => { c.compression.targetSimilarity = 1.0; }, "targetSimilarity upper bound");
});

test("image config validates complete grouped settings and document permissions without persisting title", () => {
  const config = valid();
  config.auto.pageAllowlist[rootID] = { grantedAt: 0 };
  config.compression.manualMaxEdge = 8192;
  assert.deepEqual(parseImageConfig(config), config);

  const legacyWithTitle = valid();
  legacyWithTitle.auto.pageAllowlist[rootID] = { grantedAt: 123, title: "Legacy Document Title" };
  const parsedLegacy = parseImageConfig(legacyWithTitle);
  assert.deepEqual(parsedLegacy.auto.pageAllowlist[rootID], { grantedAt: 123 });
  assert.equal("title" in parsedLegacy.auto.pageAllowlist[rootID], false);

  for (const id of ["20250101000000-ABCDEFG", "20250101000000-abcdefg_", "2025010100000-abcdefg"]) {
    rejects(c => { c.auto.pageAllowlist[id] = { grantedAt: 1 }; }, id);
  }
  rejects(c => { c.auto.pageAllowlist[rootID] = { grantedAt: -1 }; }, "negative timestamp");
});

test("compression options enforce numeric bounds and complete schema", () => {
  const maxAllowed = valid();
  maxAllowed.compression.manualMaxEdge = 16383;
  assert.equal(parseImageConfig(maxAllowed).compression.manualMaxEdge, 16383);

  for (const value of [0.009, 1.01]) rejects(c => { c.compression.initialQuality = value; }, `quality ${value}`);
  for (const value of [512.5, 511, 16384]) rejects(c => { c.compression.manualMaxEdge = value; }, `dimension ${value}`);
  rejects(c => { c.metadata.preserveExif = true; }, "EXIF unsupported");
});

test("extension lists are deduplicated and validated", () => {
  const config = valid();
  config.compression.excludedExtensions = ["gif", "gif"];
  assert.deepEqual(parseImageConfig(config).compression.excludedExtensions, ["gif"]);
  rejects(c => { c.compression.excludedExtensions = ["bad extension"]; }, "invalid excludedExtension");
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

test("rejects unsupported schemaVersion including v1 and v3", () => {
  for (const version of [1, 3]) {
    const unknown = valid();
    unknown.schemaVersion = version;
    assert.throws(() => parseImageConfig(unknown));
  }
});
