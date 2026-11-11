import { test } from "node:test";
import assert from "node:assert/strict";
import { defaultImageFeatureConfig, parseImageConfig } from "../src/features/image-compressor/parseImageConfig.ts";

const valid = () => defaultImageFeatureConfig();
const rootID = "20250101000000-abcdefg";
const rejects = (mutate, label) => {
  const config = valid();
  mutate(config);
  assert.throws(() => parseImageConfig(config), undefined, label);
};

test("image config accepts boundary values and SiYuan root IDs", () => {
  const config = valid();
  config.autoCompression.pageAllowlist[rootID] = { grantedAt: 0, titleSnapshot: "", notebookIdSnapshot: "box" };
  Object.assign(config.compression, {
    concurrencyDesktop: 8, concurrencyMobile: 3, maxDimension: 8192,
    minSizeBytes: 100 * 1024 * 1024,
  });
  assert.deepEqual(parseImageConfig(config), config);
});

test("compression integer settings reject fractions and values outside bounds", () => {
  for (const value of [0.5, 0, 9]) rejects(c => { c.compression.concurrencyDesktop = value; }, `desktop ${value}`);
  for (const value of [1.5, 0, 4]) rejects(c => { c.compression.concurrencyMobile = value; }, `mobile ${value}`);
  for (const value of [256.5, 255, 8193]) rejects(c => { c.compression.maxDimension = value; }, `dimension ${value}`);
  for (const value of [-1, 0.5, 100 * 1024 * 1024 + 1]) rejects(c => { c.compression.minSizeBytes = value; }, `size ${value}`);
});

test("allowlist permissions require valid root IDs, finite nonnegative timestamp and typed snapshots", () => {
  for (const id of ["20250101000000-ABCDEFG", "20250101000000-abcdefg_", "2025010100000-abcdefg"]) {
    rejects(c => { c.autoCompression.pageAllowlist[id] = { grantedAt: 1 }; }, id);
  }
  for (const grantedAt of [-1, NaN, Infinity, "1"]) {
    rejects(c => { c.autoCompression.pageAllowlist[rootID] = { grantedAt }; }, `timestamp ${grantedAt}`);
  }
  rejects(c => { c.autoCompression.pageAllowlist[rootID] = { grantedAt: 1, titleSnapshot: 4 }; }, "title type");
  rejects(c => { c.autoCompression.pageAllowlist[rootID] = { grantedAt: 1, notebookIdSnapshot: null }; }, "notebook type");
});

test("legacy schema v1 excluded extension booleans remain readable", () => {
  const config = valid();
  delete config.compression.excludedExtensions;
  Object.assign(config.compression, { skipWebP: false, skipGIF: true, skipSVG: true, skipExcalidraw: true });
  assert.equal(parseImageConfig(config).compression.excludedExtensions, "gif,svg");
});
