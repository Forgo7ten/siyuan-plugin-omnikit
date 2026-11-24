import { test } from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_WEIGHTS,
  computeMSSSIM,
  precalculateOriginal,
  evaluateMSSSIMWithPrecomputed,
  extractPerceptualPlanes,
  containsTransparency,
  gaussianBlur,
  makeGaussianKernel,
} from "../../../src/features/image-compressor/similarity/ms-ssim.ts";
import {
  combineHybridScores,
  computeProxyDimensions,
  selectDetailPatches,
} from "../../../src/features/image-compressor/similarity/patch-selector.ts";
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

test("MS-SSIM returns 1.0 for identical image frames and uses updated fine-scale weights", () => {
  assert.deepEqual(DEFAULT_WEIGHTS, [0.20, 0.30, 0.25, 0.15, 0.10]);
  const frameA = createPatternFrame(64, 64, 0);
  const frameB = createPatternFrame(64, 64, 0);
  const score = computeMSSSIM(frameA, frameB);
  assert.ok(Math.abs(score - 1.0) < 0.0001, `Expected ~1.0, got ${score}`);
});

test("MS-SSIM precalculation produces identical result to computeMSSSIM and supports reusable blur buffers", () => {
  const original = createPatternFrame(64, 64, 0);
  const candidate = createPatternFrame(64, 64, 10);

  const directScore = computeMSSSIM(original, candidate);
  const precalculated = precalculateOriginal(original);
  const fastScore = evaluateMSSSIMWithPrecomputed(precalculated, candidate);

  assert.ok(
    Math.abs(directScore - fastScore) < 0.00001,
    `Direct score ${directScore} vs Fast score ${fastScore}`,
  );
  assert.ok(directScore < 1.0 && directScore > 0.2, `Expected score in (0.2, 1.0), got ${directScore}`);

  const kernel = makeGaussianKernel(11, 1.5);
  const src = precalculated.scales[0].channels[0].a;
  const freshBlur = gaussianBlur(src, 64, 64, kernel);
  const scratchH = new Float32Array(128 * 128);
  const outBuf = new Float32Array(128 * 128);
  const reusedBlur = gaussianBlur(src, 64, 64, kernel, scratchH, outBuf);
  assert.equal(reusedBlur.length, 64 * 64);
  for (let i = 0; i < freshBlur.length; i++) {
    assert.ok(Math.abs(freshBlur[i] - reusedBlur[i]) < 1e-6);
  }
});

test("extractPerceptualPlanes never mutates PixelFrame.data and extracts single luma or float-premultiplied luma + alpha", () => {
  const opaqueData = new Uint8ClampedArray([
    100, 150, 200, 255,
    50, 60, 70, 255,
  ]);
  const opaqueSnapshot = new Uint8ClampedArray(opaqueData);
  const opaqueFrame = { width: 2, height: 1, data: opaqueData };
  assert.equal(containsTransparency(opaqueFrame), false);
  const opaquePlanes = extractPerceptualPlanes(opaqueFrame);
  assert.equal(opaquePlanes.alpha, undefined, "opaque image must only allocate single luma channel");
  assert.deepEqual(opaqueData, opaqueSnapshot);

  const transData = new Uint8ClampedArray([
    50, 60, 70, 255,     // opaque pixel BEFORE transparent pixel
    100, 150, 200, 0,    // fully transparent pixel
    200, 100, 50, 128,   // semi-transparent pixel (float premultiply, not rounded)
    80, 90, 100, 255,    // opaque pixel AFTER transparent pixel
  ]);
  const transSnapshot = new Uint8ClampedArray(transData);
  const transFrame = { width: 4, height: 1, data: transData };
  assert.equal(containsTransparency(transFrame), true);

  const firstCall = extractPerceptualPlanes(transFrame);
  const secondCall = extractPerceptualPlanes(transFrame);
  assert.deepEqual(transData, transSnapshot, "extractPerceptualPlanes must never mutate input RGBA buffer");
  assert.deepEqual(firstCall.luma, secondCall.luma, "repeated calls on same PixelFrame must be idempotent");
  assert.deepEqual(firstCall.alpha, secondCall.alpha);

  assert.ok(firstCall.alpha instanceof Float32Array);
  assert.deepEqual([...firstCall.alpha], [255, 0, 128, 255]);
  assert.equal(firstCall.luma[1], 0);
  const expectedSemiLuma = (0.2126 * 200 + 0.7152 * 100 + 0.0722 * 50) * (128 / 255);
  assert.ok(Math.abs(firstCall.luma[2] - expectedSemiLuma) < 1e-4);

  // Calling computeMSSSIM multiple times on the same transparent PixelFrame must be idempotent
  const candidate = { width: 4, height: 1, data: new Uint8ClampedArray(transData) };
  candidate.data[8] = 180;
  const s1 = computeMSSSIM(transFrame, candidate);
  const s2 = computeMSSSIM(transFrame, candidate);
  assert.equal(s1, s2);
  assert.deepEqual(transData, transSnapshot);
});

test("L4 spatial error pooling penalizes localized text/edge blur on large whitespace much more strongly than L1 mean", () => {
  const width = 128;
  const height = 128;
  const origData = new Uint8ClampedArray(width * height * 4).fill(255);
  const blurredData = new Uint8ClampedArray(width * height * 4).fill(255);

  // Small 16x16 high-contrast checkerboard "text glyph" block in a sea of white background
  for (let y = 16; y < 32; y++) {
    for (let x = 16; x < 32; x++) {
      const idx = (y * width + x) * 4;
      const ink = (x + y) % 2 === 0 ? 10 : 245;
      origData[idx] = ink;
      origData[idx + 1] = ink;
      origData[idx + 2] = ink;
      // Candidate smears the sharp text to flat grey
      blurredData[idx] = 128;
      blurredData[idx + 1] = 128;
      blurredData[idx + 2] = 128;
    }
  }

  const orig = { width, height, data: origData };
  const cand = { width, height, data: blurredData };
  const l1Score = computeMSSSIM(orig, cand, { poolingExponent: 1 });
  const l4Score = computeMSSSIM(orig, cand, { poolingExponent: 4 });

  // Under L1 mean, 98.4% white background dilutes local text blur above ~0.985; L4 catches it sharply
  assert.ok(l1Score > 0.98, `Expected L1 mean > 0.98 due to background dilution, got ${l1Score}`);
  assert.ok(l4Score < l1Score - 0.05, `Expected L4 (${l4Score}) << L1 (${l1Score}) on localized text blur`);
  assert.ok(l4Score < 0.94, `Expected L4 score < 0.94 on smeared text region, got ${l4Score}`);
});

test("patch-selector handles <=768 full-frame, ignores 1px straight borders for 2D text, stratifies tall screenshots, and falls back deterministically", () => {
  const smallProxy = createPatternFrame(600, 400);
  assert.deepEqual(selectDetailPatches(smallProxy, 768, 512), []);

  // Proxy dimensions protect short edge >= 256 for tall screenshots while capping extreme strips at <= 1536
  const tallProxyDims = computeProxyDimensions(1080, 5000);
  assert.equal(tallProxyDims.width, 256);
  assert.ok(tallProxyDims.height <= 1536 && tallProxyDims.height > 1000);
  const extremeDims = computeProxyDimensions(1080, 20000);
  assert.ok(extremeDims.height <= 1536 && extremeDims.height >= 1535);
  assert.ok(extremeDims.width >= 1);

  // 1600x1200 image with a full-height 1px vertical sidebar divider at x=100 vs a 2D text-like patch around (1100, 750)
  const pw = 800;
  const ph = 600;
  const uiData = new Uint8ClampedArray(pw * ph * 4).fill(255);
  for (let y = 0; y < ph; y++) {
    const lineIdx = (y * pw + 50) * 4;
    uiData[lineIdx] = 0;
    uiData[lineIdx + 1] = 0;
    uiData[lineIdx + 2] = 0;
  }
  for (let y = 360; y < 440; y++) {
    for (let x = 540; x < 640; x++) {
      const idx = (y * pw + x) * 4;
      // 2D character-stroke grid (3pxx3px strokes with 2D corners so both gx > 0 and gy > 0)
      const v = (x % 6 < 3) !== (y % 6 < 3) ? 20 : 235;
      uiData[idx] = v;
      uiData[idx + 1] = v;
      uiData[idx + 2] = v;
    }
  }
  const uiPatches = selectDetailPatches({ width: pw, height: ph, data: uiData }, 1600, 1200);
  assert.equal(uiPatches.length, 2);
  // Top patch must lock onto the 2D text cluster [1080..1280, 720..880] and completely ignore the 1px border at x=100
  assert.ok(uiPatches[0].x > 200, `Expected patch to ignore x=100 1px line, got x=${uiPatches[0].x}`);
  assert.ok(uiPatches[0].x <= 1080 && uiPatches[0].x + uiPatches[0].width >= 1280);
  assert.ok(uiPatches[0].y <= 720 && uiPatches[0].y + uiPatches[0].height >= 880);

  // 1080x5000 tall screenshot with text in both upper and lower halves -> stratified non-overlapping patches
  const tallData = new Uint8ClampedArray(tallProxyDims.width * tallProxyDims.height * 4).fill(255);
  const paintCluster = (cx, cy) => {
    for (let y = cy; y < cy + 40; y++) {
      for (let x = cx; x < cx + 60; x++) {
        const idx = (y * tallProxyDims.width + x) * 4;
        const v = (x % 6 < 3) !== (y % 6 < 3) ? 15 : 240;
        tallData[idx] = v; tallData[idx + 1] = v; tallData[idx + 2] = v;
      }
    }
  };
  paintCluster(80, 120); // upper half
  paintCluster(90, 900); // lower half
  const tallPatches = selectDetailPatches(
    { width: tallProxyDims.width, height: tallProxyDims.height, data: tallData },
    1080,
    5000,
  );
  assert.equal(tallPatches.length, 2);
  assert.ok(tallPatches[0].y < 2300, `Expected first patch in upper half, got y=${tallPatches[0].y}`);
  assert.ok(tallPatches[1].y >= 2300, `Expected second patch in lower half, got y=${tallPatches[1].y}`);

  // 1080x5000 tall screenshot with 2 text clusters in upper half and pure blank lower half -> skips empty lower segment
  const halfBlankData = new Uint8ClampedArray(tallProxyDims.width * tallProxyDims.height * 4).fill(255);
  const paintUpperCluster = (cx, cy) => {
    for (let y = cy; y < cy + 36; y++) {
      for (let x = cx; x < cx + 56; x++) {
        const idx = (y * tallProxyDims.width + x) * 4;
        const v = (x % 6 < 3) !== (y % 6 < 3) ? 15 : 240;
        halfBlankData[idx] = v; halfBlankData[idx + 1] = v; halfBlankData[idx + 2] = v;
      }
    }
  };
  paintUpperCluster(60, 60);
  paintUpperCluster(80, 320);
  const halfBlankPatches = selectDetailPatches(
    { width: tallProxyDims.width, height: tallProxyDims.height, data: halfBlankData },
    1080,
    5000,
  );
  assert.equal(halfBlankPatches.length, 2);
  assert.ok(halfBlankPatches[0].y < 2200 && halfBlankPatches[1].y < 2200, "Both patches must cover upper text clusters instead of blank lower half");

  // Transparent PNG with pure black (0,0,0,255) text/strokes vs a tiny (10,10,10,255) speck -> locks onto black text
  const transPw = 600;
  const transPh = 600;
  const transBlackText = new Uint8ClampedArray(transPw * transPh * 4); // (0, 0, 0, 0) everywhere
  // Tiny isolated grey speck at (520, 520)
  for (let y = 520; y < 522; y++) {
    for (let x = 520; x < 522; x++) {
      const idx = (y * transPw + x) * 4;
      transBlackText[idx] = 10; transBlackText[idx + 1] = 10; transBlackText[idx + 2] = 10; transBlackText[idx + 3] = 255;
    }
  }
  // Dense pure-black text strokes around (100..220, 100..220)
  for (let y = 100; y < 220; y++) {
    for (let x = 100; x < 220; x++) {
      if ((x % 6 < 3) !== (y % 6 < 3)) {
        const idx = (y * transPw + x) * 4;
        transBlackText[idx + 3] = 255; // RGB = 0,0,0, Alpha = 255
      }
    }
  }
  const transPatches = selectDetailPatches({ width: transPw, height: transPh, data: transBlackText }, 1200, 1200);
  assert.equal(transPatches.length, 2);
  assert.ok(transPatches[0].x <= 200 && transPatches[0].y <= 200, `Top patch must cover pure-black strokes on transparent background, got (${transPatches[0].x}, ${transPatches[0].y})`);

  // Solid-color & narrow image fallback: deterministic, non-overlapping, in-bounds
  const solidData = new Uint8ClampedArray(256 * 512 * 4).fill(200);
  const solidPatches = selectDetailPatches({ width: 256, height: 512, data: solidData }, 300, 1200);
  assert.equal(solidPatches.length, 2);
  for (const rect of solidPatches) {
    assert.equal(rect.width, 300);
    assert.equal(rect.height, 384);
    assert.ok(rect.x >= 0 && rect.x + rect.width <= 300);
    assert.ok(rect.y >= 0 && rect.y + rect.height <= 1200);
  }
  assert.ok(Math.abs(solidPatches[0].y - solidPatches[1].y) >= 384);

  assert.equal(combineHybridScores(0.98, []), 0.98);
  assert.ok(Math.abs(combineHybridScores(0.99, [0.95, 0.90]) - (0.2 * 0.99 + 0.8 * 0.90)) < 1e-9);
});

test("similarity policy differentiates desktop vs mobile with updated parameters", () => {
  setFrontendResolver(() => "desktop");
  const desktopPolicy = getSimilarityPolicy();
  assert.deepEqual(desktopPolicy, {
    maxEvaluations: 5,
    fullFrameMaxEdge: 768,
    globalMaxEdge: 512,
    patchSize: 384,
    patchCount: 2,
    startQuality: 0.78,
    qualityTolerance: 0.02,
    minQuality: 0.5,
    maxQuality: 1.0,
  });

  setFrontendResolver(() => "mobile");
  const mobilePolicy = getSimilarityPolicy();
  assert.equal(mobilePolicy.maxEvaluations, 4);
  assert.equal(mobilePolicy.fullFrameMaxEdge, 768);
  assert.equal(mobilePolicy.minQuality, 0.5);
  assert.equal(mobilePolicy.qualityTolerance, 0.02);
  assert.equal(mobilePolicy.startQuality, 0.78);

  setFrontendResolver(undefined);
});

test("adaptiveQualitySearch converges to lowest qualifying quality", async () => {
  const encode = async (quality) => {
    const size = Math.round(1000 + quality * 9000);
    return new Blob([new Uint8Array(size)]);
  };
  const evaluate = async (blob) => {
    const ratio = (blob.size - 1000) / 9000;
    return 0.85 + ratio * 0.145;
  };

  const progressRounds = [];
  const result = await adaptiveQualitySearch({
    targetSimilarity: 0.95,
    initialQuality: 0.78,
    minQuality: 0.5,
    maxQuality: 1.0,
    qualityTolerance: 0.02,
    maxEvaluations: 5,
    encode,
    evaluate,
    onProgress: p => progressRounds.push(p),
  });

  assert.equal(result.status, "met");
  assert.ok(result.candidate.similarity >= 0.95);
  assert.ok(progressRounds.length <= 5);
  assert.ok(result.candidates.every(c => typeof c.similarity === "number"));
});

test("adaptiveQualitySearch enforces maxAllowedBytes monotonic early stopping in 1 round or without decoding oversize minQuality", async () => {
  // Case 1: Round 1 has bytes > maxAllowedBytes AND similarity < target -> stops in 1 round!
  let round1Calls = 0;
  const earlyStop1 = await adaptiveQualitySearch({
    targetSimilarity: 0.99,
    initialQuality: 0.78,
    maxAllowedBytes: 5000,
    encode: async (q) => {
      round1Calls++;
      return new Blob([new Uint8Array(Math.round(4000 + q * 4000))]); // q=0.78 => 7120 > 5000
    },
    evaluate: async () => 0.96, // < 0.99
  });
  assert.equal(earlyStop1.status, "insufficient-savings");
  assert.equal(round1Calls, 1);
  assert.equal(earlyStop1.candidates.length, 1);

  // Case 2: Round 1 meets similarity, minQuality (0.5) still exceeds maxAllowedBytes -> skips evaluate on minQuality!
  let encodeCalls = 0;
  let evaluateCalls = 0;
  const earlyStopMin = await adaptiveQualitySearch({
    targetSimilarity: 0.99,
    initialQuality: 0.78,
    minQuality: 0.5,
    maxAllowedBytes: 5000,
    encode: async (q) => {
      encodeCalls++;
      return new Blob([new Uint8Array(Math.round(3000 + q * 5000))]); // q=0.5 => 5500 > 5000
    },
    evaluate: async () => {
      evaluateCalls++;
      return 0.995;
    },
  });
  assert.equal(earlyStopMin.status, "insufficient-savings");
  assert.equal(encodeCalls, 2);
  assert.equal(evaluateCalls, 1, "must skip decoding/MS-SSIM when minQuality bytes already exceed maxAllowedBytes");

  // Case 3: Initial (0.78) meets similarity but exceeds budget; search narrows toward minQuality (0.5) to find smaller qualifying candidate
  const bracketed = await adaptiveQualitySearch({
    targetSimilarity: 0.99,
    initialQuality: 0.78,
    minQuality: 0.5,
    maxQuality: 1.0,
    maxAllowedBytes: 7000,
    encode: async (q) => new Blob([new Uint8Array(Math.round(1000 + q * 9000))]),
    evaluate: async (blob) => {
      const q = (blob.size - 1000) / 9000;
      return Math.min(0.999, 0.95 + q * 0.065); // reaches 0.99 around q ~= 0.615 (size ~= 6538 <= 7000)
    },
  });
  assert.equal(bracketed.status, "met");
  assert.ok(bracketed.candidate.similarity >= 0.99);
  assert.ok(bracketed.candidate.bytes <= 7000);

  // Case 4: If initial (0.78) ALREADY qualifies (similarity >= target && bytes <= budget),
  // a non-monotonic byte bump on an intermediate probe must NOT discard the valid initial candidate!
  const nonMonotonicSize = await adaptiveQualitySearch({
    targetSimilarity: 0.99,
    initialQuality: 0.78,
    minQuality: 0.5,
    maxQuality: 1.0,
    maxAllowedBytes: 5000,
    encode: async (q) => {
      if (Math.abs(q - 0.78) < 1e-3) return new Blob([new Uint8Array(4800)]); // valid! <= 5000
      if (Math.abs(q - 0.50) < 1e-3) return new Blob([new Uint8Array(3000)]);
      return new Blob([new Uint8Array(5100)]); // intermediate Huffman bump > 5000
    },
    evaluate: async (blob) => {
      if (blob.size === 4800) return 0.993; // meets target!
      if (blob.size === 3000) return 0.970;
      return 0.985; // < target while > budget
    },
  });
  assert.equal(nonMonotonicSize.status, "met");
  assert.equal(nonMonotonicSize.candidate.bytes, 4800);
  assert.equal(nonMonotonicSize.candidate.quality, 0.78);
});

test("adaptiveQualitySearch returns unreachable when max quality does not meet target", async () => {
  const encode = async (quality) => new Blob([new Uint8Array(Math.round(100 + quality * 100))]);
  const evaluate = async (blob) => (blob.size / 200) * 0.92;

  const result = await adaptiveQualitySearch({
    targetSimilarity: 0.99,
    initialQuality: 0.78,
    minQuality: 0.5,
    maxQuality: 1.0,
    qualityTolerance: 0.02,
    maxEvaluations: 5,
    encode,
    evaluate,
  });

  assert.equal(result.status, "unreachable");
  assert.ok(result.bestCandidate.similarity < 0.99);
  assert.equal(result.converged, false);
});
