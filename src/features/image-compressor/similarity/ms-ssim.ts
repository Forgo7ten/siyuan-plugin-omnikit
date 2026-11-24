export interface PixelFrame {
  width: number;
  height: number;
  data: Uint8ClampedArray | Uint8Array;
}

export interface MSSSIMOptions {
  maxScales?: number;
  windowSize?: number;
  sigma?: number;
  weights?: readonly number[];
  poolingExponent?: number;
}

export interface ChannelComponents {
  luminance: number;
  contrastStructure: number;
}

export interface PrecomputedScaleChannel {
  a: Float32Array;
  meanA: Float32Array;
  varianceA: Float32Array;
}

export interface PrecomputedScale {
  width: number;
  height: number;
  windowSize: number;
  kernel: Float32Array;
  channels: PrecomputedScaleChannel[];
}

export interface PrecomputedOriginal {
  width: number;
  height: number;
  includeAlpha: boolean;
  totalScales: number;
  weights: number[];
  poolingExponent: number;
  scales: PrecomputedScale[];
}

export const DEFAULT_WEIGHTS = [0.20, 0.30, 0.25, 0.15, 0.10];
const C1 = (0.01 * 255) ** 2;
const C2 = (0.03 * 255) ** 2;

function assertFrame(frame: PixelFrame, name: string): void {
  if (
    !Number.isSafeInteger(frame.width) ||
    !Number.isSafeInteger(frame.height) ||
    frame.width < 1 ||
    frame.height < 1
  ) {
    throw new Error(`${name} has invalid dimensions`);
  }
  if (frame.data.length !== frame.width * frame.height * 4) {
    throw new Error(`${name} RGBA buffer length does not match dimensions`);
  }
}

export function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(1, value));
}

export function containsTransparency(frame: PixelFrame): boolean {
  const data = frame.data;
  for (let i = 3; i < data.length; i += 4) {
    if (data[i] !== 255) return true;
  }
  return false;
}

/**
 * Extracts perceptual Rec.709 floating-point premultiplied luminance plane and optional alpha plane
 * in a single pass without mutating `frame.data`.
 */
export function extractPerceptualPlanes(frame: PixelFrame): { luma: Float32Array; alpha?: Float32Array } {
  assertFrame(frame, "frame");
  const pixelCount = frame.width * frame.height;
  const luma = new Float32Array(pixelCount);
  let alpha: Float32Array | undefined;
  const data = frame.data;

  for (let p = 0, i = 0; p < pixelCount; p++, i += 4) {
    const r = data[i];
    const g = data[i + 1];
    const b = data[i + 2];
    const a = data[i + 3];
    if (a === 255) {
      luma[p] = 0.2126 * r + 0.7152 * g + 0.0722 * b;
      if (alpha !== undefined) {
        alpha[p] = 255;
      }
    } else {
      if (alpha === undefined) {
        alpha = new Float32Array(pixelCount);
        alpha.fill(255, 0, p);
      }
      if (a === 0) {
        luma[p] = 0;
        alpha[p] = 0;
      } else {
        luma[p] = (0.2126 * r + 0.7152 * g + 0.0722 * b) * (a / 255);
        alpha[p] = a;
      }
    }
  }

  return alpha ? { luma, alpha } : { luma };
}

export function makeGaussianKernel(size: number, sigma: number): Float32Array {
  if (size <= 1) return new Float32Array([1]);
  const radius = Math.floor(size / 2);
  const kernel = new Float32Array(size);
  let total = 0;
  for (let i = -radius; i <= radius; i++) {
    const value = Math.exp(-(i * i) / (2 * sigma * sigma));
    kernel[i + radius] = value;
    total += value;
  }
  for (let i = 0; i < size; i++) kernel[i] /= total;
  return kernel;
}

export function gaussianBlur(
  source: Float32Array,
  width: number,
  height: number,
  kernel: Float32Array,
  scratchHorizontal?: Float32Array,
  outputBuffer?: Float32Array,
): Float32Array {
  const len = width * height;
  if (kernel.length === 1) {
    if (outputBuffer && outputBuffer.length >= len && outputBuffer !== source) {
      outputBuffer.set(source.subarray(0, len), 0);
      return outputBuffer.length === len ? outputBuffer : outputBuffer.subarray(0, len);
    }
    return source.length === len ? source : source.subarray(0, len);
  }
  const radius = Math.floor(kernel.length / 2);
  const horizontal = scratchHorizontal && scratchHorizontal.length >= len
    ? scratchHorizontal
    : new Float32Array(len);
  const output = outputBuffer && outputBuffer.length >= len
    ? outputBuffer
    : new Float32Array(len);

  for (let y = 0; y < height; y++) {
    const row = y * width;
    for (let x = 0; x < width; x++) {
      let sum = 0;
      for (let k = -radius; k <= radius; k++) {
        const sx = Math.max(0, Math.min(width - 1, x + k));
        sum += source[row + sx] * kernel[k + radius];
      }
      horizontal[row + x] = sum;
    }
  }

  for (let y = 0; y < height; y++) {
    const row = y * width;
    for (let x = 0; x < width; x++) {
      let sum = 0;
      for (let k = -radius; k <= radius; k++) {
        const sy = Math.max(0, Math.min(height - 1, y + k));
        sum += horizontal[sy * width + x] * kernel[k + radius];
      }
      output[row + x] = sum;
    }
  }
  return output.length === len ? output : output.subarray(0, len);
}

export function downsample(
  source: Float32Array,
  width: number,
  height: number,
): { data: Float32Array; width: number; height: number } {
  const nextWidth = Math.max(1, Math.floor(width / 2));
  const nextHeight = Math.max(1, Math.floor(height / 2));
  const output = new Float32Array(nextWidth * nextHeight);
  for (let y = 0; y < nextHeight; y++) {
    for (let x = 0; x < nextWidth; x++) {
      const sx = x * 2;
      const sy = y * 2;
      const x1 = Math.min(width - 1, sx + 1);
      const y1 = Math.min(height - 1, sy + 1);
      const a = source[sy * width + sx];
      const b = source[sy * width + x1];
      const c = source[y1 * width + sx];
      const d = source[y1 * width + x1];
      output[y * nextWidth + x] = (a + b + c + d) * 0.25;
    }
  }
  return { data: output, width: nextWidth, height: nextHeight };
}

export function scaleCount(width: number, height: number, requested: number): number {
  let count = 1;
  let minEdge = Math.min(width, height);
  while (count < requested && minEdge >= 16) {
    count++;
    minEdge = Math.floor(minEdge / 2);
  }
  return count;
}

export function windowFor(width: number, height: number, preferred: number): number {
  const edge = Math.min(width, height, preferred);
  if (edge <= 1) return 1;
  return edge % 2 === 0 ? edge - 1 : edge;
}

function combinePerceptualChannels(
  values: ChannelComponents[],
  includeAlpha: boolean,
): ChannelComponents {
  if (!includeAlpha || values.length < 2) {
    return values[0];
  }
  return {
    luminance: values[0].luminance * 0.85 + values[1].luminance * 0.15,
    contrastStructure: values[0].contrastStructure * 0.85 + values[1].contrastStructure * 0.15,
  };
}

/**
 * Precalculates the 5-scale pyramid and Gaussian statistics (meanA, varianceA)
 * for the original image once without mutating `frame.data`.
 */
export function precalculateOriginal(
  frame: PixelFrame,
  options: MSSSIMOptions = {},
): PrecomputedOriginal {
  assertFrame(frame, "original");

  const requestedScales = Math.max(1, Math.min(5, Math.floor(options.maxScales ?? 5)));
  const preferredWindow = Math.max(1, Math.floor(options.windowSize ?? 11));
  const preferredSigma = Math.max(0.1, options.sigma ?? 1.5);
  const poolingExponent = options.poolingExponent ?? 4;
  const totalScales = scaleCount(frame.width, frame.height, requestedScales);

  const sourceWeights = options.weights && options.weights.length >= totalScales
    ? options.weights
    : DEFAULT_WEIGHTS;
  const weights = sourceWeights.slice(0, totalScales);
  const weightTotal = weights.reduce((sum, v) => sum + v, 0);
  for (let i = 0; i < weights.length; i++) weights[i] /= weightTotal;

  const planes = extractPerceptualPlanes(frame);
  const includeAlpha = planes.alpha !== undefined;
  let channels: Float32Array[] = planes.alpha ? [planes.luma, planes.alpha] : [planes.luma];

  let width = frame.width;
  let height = frame.height;
  const maxLen = width * height;
  const a2Scratch = new Float32Array(maxLen);
  const scratchH = new Float32Array(maxLen);
  const meanA2Scratch = new Float32Array(maxLen);
  const scales: PrecomputedScale[] = [];

  for (let scale = 0; scale < totalScales; scale++) {
    const windowSize = windowFor(width, height, preferredWindow);
    const sigma = preferredSigma * (windowSize / preferredWindow);
    const kernel = makeGaussianKernel(windowSize, sigma);
    const len = width * height;

    const scaleChannels: PrecomputedScaleChannel[] = [];
    for (let i = 0; i < channels.length; i++) {
      const a = channels[i];
      const a2 = a2Scratch.subarray(0, len);
      for (let j = 0; j < len; j++) {
        a2[j] = a[j] * a[j];
      }
      const meanA = gaussianBlur(a, width, height, kernel, scratchH);
      const meanA2 = gaussianBlur(a2, width, height, kernel, scratchH, meanA2Scratch.subarray(0, len));
      const varianceA = new Float32Array(len);
      for (let j = 0; j < len; j++) {
        varianceA[j] = Math.max(0, meanA2[j] - meanA[j] * meanA[j]);
      }
      scaleChannels.push({ a, meanA, varianceA });
    }

    scales.push({ width, height, windowSize, kernel, channels: scaleChannels });

    if (scale + 1 < totalScales) {
      channels = channels.map(c => downsample(c, width, height).data);
      width = Math.max(1, Math.floor(width / 2));
      height = Math.max(1, Math.floor(height / 2));
    }
  }

  return {
    width: frame.width,
    height: frame.height,
    includeAlpha,
    totalScales,
    weights,
    poolingExponent,
    scales,
  };
}

/**
 * Fast evaluation of candidate WebP using precalculated original statistics,
 * reusable convolution scratch buffers, and L4 error spatial pooling.
 */
export function evaluateMSSSIMWithPrecomputed(
  precomputed: PrecomputedOriginal,
  candidate: PixelFrame,
  options?: Pick<MSSSIMOptions, "poolingExponent">,
): number {
  assertFrame(candidate, "candidate");
  if (candidate.width !== precomputed.width || candidate.height !== precomputed.height) {
    throw new Error("Candidate dimensions do not match precalculated original");
  }

  const planes = extractPerceptualPlanes(candidate);
  let channels: Float32Array[];
  if (precomputed.includeAlpha) {
    let alphaPlane = planes.alpha;
    if (!alphaPlane) {
      alphaPlane = new Float32Array(candidate.width * candidate.height);
      alphaPlane.fill(255);
    }
    channels = [planes.luma, alphaPlane];
  } else {
    channels = [planes.luma];
  }

  let width = candidate.width;
  let height = candidate.height;
  const maxLen = width * height;
  const b2Buf = new Float32Array(maxLen);
  const abBuf = new Float32Array(maxLen);
  const scratchH = new Float32Array(maxLen);
  const meanBBuf = new Float32Array(maxLen);
  const meanB2Buf = new Float32Array(maxLen);
  const meanABBuf = new Float32Array(maxLen);

  const poolingExponent = options?.poolingExponent ?? precomputed.poolingExponent ?? 4;
  const luminanceByScale: number[] = [];
  const contrastByScale: number[] = [];

  for (let scale = 0; scale < precomputed.totalScales; scale++) {
    const scaleInfo = precomputed.scales[scale];
    const kernel = scaleInfo.kernel;
    const len = width * height;

    const channelResults: ChannelComponents[] = [];
    for (let i = 0; i < channels.length; i++) {
      const b = channels[i];
      const preCh = scaleInfo.channels[i];
      const a = preCh.a;
      const meanA = preCh.meanA;
      const varianceA = preCh.varianceA;

      const b2 = b2Buf.subarray(0, len);
      const ab = abBuf.subarray(0, len);
      for (let j = 0; j < len; j++) {
        b2[j] = b[j] * b[j];
        ab[j] = a[j] * b[j];
      }

      const meanB = gaussianBlur(b, width, height, kernel, scratchH, meanBBuf.subarray(0, len));
      const meanB2 = gaussianBlur(b2, width, height, kernel, scratchH, meanB2Buf.subarray(0, len));
      const meanAB = gaussianBlur(ab, width, height, kernel, scratchH, meanABBuf.subarray(0, len));

      let luminanceTotal = 0;
      let contrastStructure = 0;

      if (poolingExponent === 1) {
        let csTotal = 0;
        for (let j = 0; j < len; j++) {
          const ma = meanA[j];
          const mb = meanB[j];
          const va = varianceA[j];
          const vb = Math.max(0, meanB2[j] - mb * mb);
          const cov = meanAB[j] - ma * mb;

          const lum = (2 * ma * mb + C1) / (ma * ma + mb * mb + C1);
          const cs = (2 * cov + C2) / (va + vb + C2);
          luminanceTotal += clamp01(lum);
          csTotal += clamp01(cs);
        }
        contrastStructure = csTotal / len;
      } else if (poolingExponent === 4) {
        let err4Total = 0;
        for (let j = 0; j < len; j++) {
          const ma = meanA[j];
          const mb = meanB[j];
          const va = varianceA[j];
          const vb = Math.max(0, meanB2[j] - mb * mb);
          const cov = meanAB[j] - ma * mb;

          const lum = (2 * ma * mb + C1) / (ma * ma + mb * mb + C1);
          const cs = (2 * cov + C2) / (va + vb + C2);
          luminanceTotal += clamp01(lum);
          const csClamped = clamp01(cs);
          const err = 1 - csClamped;
          const err2 = err * err;
          err4Total += err2 * err2;
        }
        contrastStructure = clamp01(1 - Math.pow(err4Total / len, 0.25));
      } else {
        let errPTotal = 0;
        for (let j = 0; j < len; j++) {
          const ma = meanA[j];
          const mb = meanB[j];
          const va = varianceA[j];
          const vb = Math.max(0, meanB2[j] - mb * mb);
          const cov = meanAB[j] - ma * mb;

          const lum = (2 * ma * mb + C1) / (ma * ma + mb * mb + C1);
          const cs = (2 * cov + C2) / (va + vb + C2);
          luminanceTotal += clamp01(lum);
          errPTotal += Math.pow(1 - clamp01(cs), poolingExponent);
        }
        contrastStructure = clamp01(1 - Math.pow(errPTotal / len, 1 / poolingExponent));
      }

      channelResults.push({
        luminance: luminanceTotal / len,
        contrastStructure,
      });
    }

    const combined = combinePerceptualChannels(channelResults, precomputed.includeAlpha);
    luminanceByScale.push(combined.luminance);
    contrastByScale.push(combined.contrastStructure);

    if (scale + 1 < precomputed.totalScales) {
      channels = channels.map(c => downsample(c, width, height).data);
      width = Math.max(1, Math.floor(width / 2));
      height = Math.max(1, Math.floor(height / 2));
    }
  }

  let score = 1;
  const weights = precomputed.weights;
  for (let scale = 0; scale < precomputed.totalScales - 1; scale++) {
    score *= Math.pow(clamp01(contrastByScale[scale]), weights[scale]);
  }
  const last = precomputed.totalScales - 1;
  score *= Math.pow(
    clamp01(luminanceByScale[last]) * clamp01(contrastByScale[last]),
    weights[last],
  );
  return clamp01(score);
}

/**
 * Standard 5-scale MS-SSIM calculation comparing two PixelFrames.
 */
export function computeMSSSIM(
  a: PixelFrame,
  b: PixelFrame,
  options: MSSSIMOptions = {},
): number {
  const pre = precalculateOriginal(a, options);
  return evaluateMSSSIMWithPrecomputed(pre, b, options);
}
