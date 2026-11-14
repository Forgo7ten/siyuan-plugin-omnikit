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

test("image defaults use schema 1 and the grouped configuration shape", () => {
  const config = valid();
  assert.equal(config.schemaVersion, 1);
  assert.deepEqual(parseImageConfig(config), config);
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
  rejects(c => { c.remote.downloadUserAgent = "x".repeat(257); }, "long user agent");
  rejects(c => { c.metadata.preserveExif = true; }, "EXIF unsupported");
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
  unknown.schemaVersion = 2;
  assert.throws(() => parseImageConfig(unknown));
});
