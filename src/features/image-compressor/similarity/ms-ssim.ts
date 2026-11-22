export interface PixelFrame {
  width: number;
  height: number;
  data: Uint8ClampedArray | Uint8Array;
}

export interface MSSSIMOptions {
  maxScales?: number;
  windowSize?: number;
  sigma?: number;
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
  scales: PrecomputedScale[];
}

const DEFAULT_WEIGHTS = [0.0448, 0.2856, 0.3001, 0.2363, 0.1333];
const LUMA_WEIGHTS = [0.2126, 0.7152, 0.0722];
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

/**
 * Pre-multiplies alpha into RGB channels:
 * - When alpha === 0, RGB is zeroed out to eliminate invisible background noise.
 * - When 0 < alpha < 255, RGB is scaled by alpha/255 (not idempotent in place).
 */
export function applyAlphaPremultiply(frame: PixelFrame): void {
  const data = frame.data;
  for (let i = 0; i < data.length; i += 4) {
    const alpha = data[i + 3];
    if (alpha === 0) {
      data[i] = 0;
      data[i + 1] = 0;
      data[i + 2] = 0;
    } else if (alpha < 255) {
      data[i] = Math.round((data[i] * alpha) / 255);
      data[i + 1] = Math.round((data[i + 1] * alpha) / 255);
      data[i + 2] = Math.round((data[i + 2] * alpha) / 255);
    }
  }
}

export function containsTransparency(frame: PixelFrame): boolean {
  const data = frame.data;
  for (let i = 3; i < data.length; i += 4) {
    if (data[i] !== 255) return true;
  }
  return false;
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
): Float32Array {
  if (kernel.length === 1) return source;
  const radius = Math.floor(kernel.length / 2);
  const horizontal = new Float32Array(source.length);
  const output = new Float32Array(source.length);

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
    for (let x = 0; x < width; x++) {
      let sum = 0;
      for (let k = -radius; k <= radius; k++) {
        const sy = Math.max(0, Math.min(height - 1, y + k));
        sum += horizontal[sy * width + x] * kernel[k + radius];
      }
      output[y * width + x] = sum;
    }
  }
  return output;
}

export function channelPlane(frame: PixelFrame, channel: number): Float32Array {
  const output = new Float32Array(frame.width * frame.height);
  for (let pixel = 0, offset = channel; pixel < output.length; pixel++, offset += 4) {
    output[pixel] = frame.data[offset];
  }
  return output;
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

export function combineChannels(
  values: ChannelComponents[],
  includeAlpha: boolean,
): ChannelComponents {
  const rgbLuminance =
    values[0].luminance * LUMA_WEIGHTS[0] +
    values[1].luminance * LUMA_WEIGHTS[1] +
    values[2].luminance * LUMA_WEIGHTS[2];
  const rgbContrast =
    values[0].contrastStructure * LUMA_WEIGHTS[0] +
    values[1].contrastStructure * LUMA_WEIGHTS[1] +
    values[2].contrastStructure * LUMA_WEIGHTS[2];

  if (!includeAlpha || values.length < 4) {
    return { luminance: rgbLuminance, contrastStructure: rgbContrast };
  }
  return {
    luminance: rgbLuminance * 0.8 + values[3].luminance * 0.2,
    contrastStructure: rgbContrast * 0.8 + values[3].contrastStructure * 0.2,
  };
}

/**
 * Precalculates the 5-scale pyramid and Gaussian statistics (meanA, meanA2, varianceA)
 * for the original image once.
 */
export function precalculateOriginal(
  frame: PixelFrame,
  options: MSSSIMOptions = {},
): PrecomputedOriginal {
  assertFrame(frame, "original");
  applyAlphaPremultiply(frame);

  const requestedScales = Math.max(1, Math.min(5, Math.floor(options.maxScales ?? 5)));
  const preferredWindow = Math.max(1, Math.floor(options.windowSize ?? 11));
  const preferredSigma = Math.max(0.1, options.sigma ?? 1.5);
  const totalScales = scaleCount(frame.width, frame.height, requestedScales);

  const weights = DEFAULT_WEIGHTS.slice(0, totalScales);
  const weightTotal = weights.reduce((sum, v) => sum + v, 0);
  for (let i = 0; i < weights.length; i++) weights[i] /= weightTotal;

  const includeAlpha = containsTransparency(frame);
  const activeChannels = includeAlpha ? [0, 1, 2, 3] : [0, 1, 2];

  let width = frame.width;
  let height = frame.height;
  let channels = activeChannels.map(c => channelPlane(frame, c));
  const scales: PrecomputedScale[] = [];

  for (let scale = 0; scale < totalScales; scale++) {
    const windowSize = windowFor(width, height, preferredWindow);
    const sigma = preferredSigma * (windowSize / preferredWindow);
    const kernel = makeGaussianKernel(windowSize, sigma);

    const scaleChannels: PrecomputedScaleChannel[] = [];
    for (let i = 0; i < channels.length; i++) {
      const a = channels[i];
      const a2 = new Float32Array(a.length);
      for (let j = 0; j < a.length; j++) {
        a2[j] = a[j] * a[j];
      }
      const meanA = gaussianBlur(a, width, height, kernel);
      const meanA2 = gaussianBlur(a2, width, height, kernel);
      const varianceA = new Float32Array(a.length);
      for (let j = 0; j < a.length; j++) {
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
    scales,
  };
}

/**
 * Fast evaluation of candidate WebP using precalculated original statistics.
 * Bypasses 50%+ of Gaussian convolution work and avoids re-decoding original image.
 */
export function evaluateMSSSIMWithPrecomputed(
  precomputed: PrecomputedOriginal,
  candidate: PixelFrame,
): number {
  assertFrame(candidate, "candidate");
  if (candidate.width !== precomputed.width || candidate.height !== precomputed.height) {
    throw new Error("Candidate dimensions do not match precalculated original");
  }
  applyAlphaPremultiply(candidate);

  const activeChannels = precomputed.includeAlpha ? [0, 1, 2, 3] : [0, 1, 2];
  let channels = activeChannels.map(c => channelPlane(candidate, c));
  let width = candidate.width;
  let height = candidate.height;

  const luminanceByScale: number[] = [];
  const contrastByScale: number[] = [];

  for (let scale = 0; scale < precomputed.totalScales; scale++) {
    const scaleInfo = precomputed.scales[scale];
    const kernel = scaleInfo.kernel;

    const channelResults: ChannelComponents[] = [];
    for (let i = 0; i < channels.length; i++) {
      const b = channels[i];
      const preCh = scaleInfo.channels[i];
      const a = preCh.a;
      const meanA = preCh.meanA;
      const varianceA = preCh.varianceA;

      const b2 = new Float32Array(b.length);
      const ab = new Float32Array(b.length);
      for (let j = 0; j < b.length; j++) {
        b2[j] = b[j] * b[j];
        ab[j] = a[j] * b[j];
      }

      const meanB = gaussianBlur(b, width, height, kernel);
      const meanB2 = gaussianBlur(b2, width, height, kernel);
      const meanAB = gaussianBlur(ab, width, height, kernel);

      let luminanceTotal = 0;
      let contrastStructureTotal = 0;
      const len = b.length;
      for (let j = 0; j < len; j++) {
        const ma = meanA[j];
        const mb = meanB[j];
        const va = varianceA[j];
        const vb = Math.max(0, meanB2[j] - mb * mb);
        const cov = meanAB[j] - ma * mb;

        const lum = (2 * ma * mb + C1) / (ma * ma + mb * mb + C1);
        const cs = (2 * cov + C2) / (va + vb + C2);
        luminanceTotal += clamp01(lum);
        contrastStructureTotal += clamp01(cs);
      }
      channelResults.push({
        luminance: luminanceTotal / len,
        contrastStructure: contrastStructureTotal / len,
      });
    }

    const combined = combineChannels(channelResults, precomputed.includeAlpha);
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
  return evaluateMSSSIMWithPrecomputed(pre, b);
}
