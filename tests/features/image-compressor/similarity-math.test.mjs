import { test } from "node:test";
import assert from "node:assert/strict";
import {
  computeMSSSIM,
  precalculateOriginal,
  evaluateMSSSIMWithPrecomputed,
  applyAlphaPremultiply,
  containsTransparency,
} from "../../../src/features/image-compressor/similarity/ms-ssim.ts";
import { getSimilarityPolicy } from "../../../src/features/image-compressor/similarity/similarity-policy.ts";
import { adaptiveQualitySearch } from "../../../src/features/image-compressor/similarity/adaptive-quality-search.ts";
import { setFrontendResolver } from "../../../src/core/host/Platform.ts";

function createPatternFrame(width, height, valueOffset = 0, alpha = 255) {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const idx = (y * width + x) * 4;
      data[idx] = (x * 4 + valueOffset) % 256;
      data[idx + 1] = (y * 4 + valueOffset) % 256;
      data[idx + 2] = ((x + y) * 2 + valueOffset) % 256;
      data[idx + 3] = alpha;
    }
  }
  return { width, height, data };
}

test("MS-SSIM returns 1.0 for identical image frames", () => {
  const frameA = createPatternFrame(64, 64, 0);
  const frameB = createPatternFrame(64, 64, 0);
  const score = computeMSSSIM(frameA, frameB);
  assert.ok(Math.abs(score - 1.0) < 0.0001, `Expected ~1.0, got ${score}`);
});

test("MS-SSIM precalculation produces identical result to computeMSSSIM", () => {
  const original = createPatternFrame(64, 64, 0);
  const candidate = createPatternFrame(64, 64, 10);

  const directScore = computeMSSSIM(original, candidate);
  const precalculated = precalculateOriginal(original);
  const fastScore = evaluateMSSSIMWithPrecomputed(precalculated, candidate);

  assert.ok(
    Math.abs(directScore - fastScore) < 0.00001,
    `Direct score ${directScore} vs Fast score ${fastScore}`,
  );
  assert.ok(directScore < 1.0 && directScore > 0.5);
});

test("applyAlphaPremultiply zeros RGB for alpha = 0 pixels", () => {
  const data = new Uint8ClampedArray([
    100, 150, 200, 0,    // transparent pixel
    50, 60, 70, 255,     // opaque pixel
  ]);
  const frame = { width: 2, height: 1, data };
  assert.equal(containsTransparency(frame), true);

  applyAlphaPremultiply(frame);
  assert.equal(data[0], 0);
  assert.equal(data[1], 0);
  assert.equal(data[2], 0);
  assert.equal(data[3], 0);

  assert.equal(data[4], 50);
  assert.equal(data[5], 60);
  assert.equal(data[6], 70);
  assert.equal(data[7], 255);
});

test("similarity policy differentiates desktop vs mobile", () => {
  setFrontendResolver(() => "desktop");
  const desktopPolicy = getSimilarityPolicy();
  assert.equal(desktopPolicy.maxEvaluations, 7);
  assert.equal(desktopPolicy.benchmarkMaxEdge, 512);

  setFrontendResolver(() => "mobile");
  const mobilePolicy = getSimilarityPolicy();
  assert.equal(mobilePolicy.maxEvaluations, 5);
  assert.equal(mobilePolicy.benchmarkMaxEdge, 512);

  setFrontendResolver(undefined);
});

test("adaptiveQualitySearch converges to lowest qualifying quality", async () => {
  // Mock encode and evaluate: higher quality = higher similarity and larger bytes
  const encode = async (quality) => {
    const size = Math.round(1000 + quality * 9000);
    return new Blob([new Uint8Array(size)]);
  };

  const evaluate = async (blob) => {
    // Monotonic function: size maps to similarity in [0.70, 0.995]
    const ratio = (blob.size - 1000) / 9000;
    return 0.70 + ratio * 0.295;
  };

  const progressRounds = [];
  const result = await adaptiveQualitySearch({
    targetSimilarity: 0.95,
    initialQuality: 0.8,
    minQuality: 0.1,
    maxQuality: 1.0,
    qualityTolerance: 0.01,
    maxEvaluations: 7,
    encode,
    evaluate,
    onProgress: p => progressRounds.push(p),
  });

  assert.equal(result.status, "met");
  assert.ok(result.candidate.similarity >= 0.95);
  assert.ok(progressRounds.length <= 7);
  assert.ok(result.candidates.every(c => typeof c.similarity === "number"));
});

test("adaptiveQualitySearch returns unreachable when max quality does not meet target", async () => {
  const encode = async (quality) => new Blob([new Uint8Array(Math.round(100 + quality * 100))]);
  // Even at 1.0, similarity only reaches 0.92
  const evaluate = async (blob) => (blob.size / 200) * 0.92;

  const result = await adaptiveQualitySearch({
    targetSimilarity: 0.99,
    initialQuality: 0.8,
    minQuality: 0.1,
    maxQuality: 1.0,
    qualityTolerance: 0.01,
    maxEvaluations: 5,
    encode,
    evaluate,
  });

  assert.equal(result.status, "unreachable");
  assert.ok(result.bestCandidate.similarity < 0.99);
  assert.equal(result.converged, false);
});
