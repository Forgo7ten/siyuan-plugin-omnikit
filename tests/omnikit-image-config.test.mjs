import { test } from "node:test";
import assert from "node:assert/strict";
import { defaultImageFeatureConfig, parseImageConfig, parseExtensions } from "../src/features/image-compressor/parseImageConfig.ts";
import { featureConfigFile, validateFeatureFiles } from "../src/core/FeatureRegistration.ts";

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
  config.compression.maxDimension = 8192;
  config.compression.concurrencyDesktop = 4;
  assert.deepEqual(parseImageConfig(config), config);
  for (const id of ["20250101000000-ABCDEFG", "20250101000000-abcdefg_", "2025010100000-abcdefg"]) {
    rejects(c => { c.auto.pageAllowlist[id] = { grantedAt: 1, title: "" }; }, id);
  }
  rejects(c => { c.auto.pageAllowlist[rootID] = { grantedAt: -1, title: "" }; }, "negative timestamp");
  rejects(c => { c.auto.pageAllowlist[rootID] = { grantedAt: 1, title: 7 }; }, "title type");
});

test("compression options enforce numeric bounds and complete schema", () => {
  for (const value of [0.09, 1.01]) rejects(c => { c.compression.initialQuality = value; }, `quality ${value}`);
  for (const value of [256.5, 255, 8193]) rejects(c => { c.compression.maxDimension = value; }, `dimension ${value}`);
  for (const value of [0.5, 0, 5]) rejects(c => { c.compression.concurrencyDesktop = value; }, `desktop ${value}`);
  rejects(c => { delete c.sources; }, "missing group");
  rejects(c => { delete c.compression.minInputBytes; }, "missing v2-shaped field");
});

test("extension lists are normalized and validated", () => {
  const config = valid();
  config.compression.excludedExtensions = ["gif", "gif"];
  assert.deepEqual(parseImageConfig(config).compression.excludedExtensions, ["gif"]);
  assert.deepEqual(parseExtensions(".GIF, svg，gif"), ["gif", "svg"]);
  assert.throws(() => parseExtensions("bad extension"));
});

test("feature IDs derive stable names and normalized collisions are rejected", () => {
  assert.equal(featureConfigFile("imageCompressor"), "feature-image-compressor.json");
  assert.throws(() => featureConfigFile("-invalid"));
  assert.throws(() => validateFeatureFiles(["imageCompressor", "imageCompressor"]));
  assert.throws(() => validateFeatureFiles(["aBC", "aBc"]));
});

test("old image config structure is rejected without migration", () => {
  const old = { schemaVersion: 1, autoCompression: { globalEnabled: false, pageAllowlist: {} }, compression: {} };
  assert.throws(() => parseImageConfig(old));
  const unknown = valid();
  unknown.schemaVersion = 2;
  assert.throws(() => parseImageConfig(unknown));
});
