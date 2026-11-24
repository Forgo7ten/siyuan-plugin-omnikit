import { clamp01, type PixelFrame } from "./ms-ssim.ts";

export interface PatchRect {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

function clampInt(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function buildStepPositions(limit: number, step: number): number[] {
  const positions: number[] = [];
  for (let pos = 0; pos <= limit; pos += step) {
    positions.push(pos);
  }
  if (positions.length === 0 || positions[positions.length - 1] !== limit) {
    positions.push(limit);
  }
  return positions;
}

function isNonOverlapping(a: PatchRect, b: PatchRect, patchArea: number): boolean {
  const ix = Math.max(0, Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x));
  const iy = Math.max(0, Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y));
  return ix * iy < 0.20 * patchArea;
}

function buildFallbackPatches(
  targetWidth: number,
  targetHeight: number,
  patchW: number,
  patchH: number,
  maxPatches: number,
): PatchRect[] {
  const patchArea = patchW * patchH;
  const spanX = targetWidth - patchW;
  const spanY = targetHeight - patchH;
  const horizontalLong = spanX >= spanY;
  const longTarget = horizontalLong ? targetWidth : targetHeight;
  const longPatch = horizontalLong ? patchW : patchH;
  const longSpan = horizontalLong ? spanX : spanY;
  const fixedCross = horizontalLong ? Math.floor(spanY / 2) : Math.floor(spanX / 2);

  if (maxPatches === 1 || longSpan <= 0) {
    return [{
      x: Math.floor(spanX / 2),
      y: Math.floor(spanY / 2),
      width: patchW,
      height: patchH,
    }];
  }

  const candidateCoords: number[] = [];
  for (let i = 0; i < maxPatches; i++) {
    candidateCoords.push(
      clampInt(Math.round(((i + 0.5) * longTarget) / maxPatches - longPatch / 2), 0, longSpan),
    );
  }
  for (let i = 0; i < maxPatches; i++) {
    candidateCoords.push(
      clampInt(Math.round((i * longSpan) / Math.max(1, maxPatches - 1)), 0, longSpan),
    );
  }

  const selected: PatchRect[] = [];
  for (const coord of candidateCoords) {
    if (selected.length >= maxPatches) break;
    const rect: PatchRect = horizontalLong
      ? { x: coord, y: fixedCross, width: patchW, height: patchH }
      : { x: fixedCross, y: coord, width: patchW, height: patchH };
    if (selected.every(existing => isNonOverlapping(existing, rect, patchArea))) {
      selected.push(rect);
    }
  }

  if (selected.length === 0) {
    selected.push({
      x: Math.floor(spanX / 2),
      y: Math.floor(spanY / 2),
      width: patchW,
      height: patchH,
    });
  }
  return selected;
}

export function computeProxyDimensions(
  targetWidth: number,
  targetHeight: number,
  maxProxyEdge = 768,
  minShortEdgeFloor = 256,
): { width: number; height: number } {
  const tw = Math.max(1, Math.floor(targetWidth));
  const th = Math.max(1, Math.floor(targetHeight));
  const longest = Math.max(tw, th);
  const shortest = Math.min(tw, th);
  const baseScale = Math.min(1, maxProxyEdge / longest);
  const shortFloorScale = Math.min(tw, th, minShortEdgeFloor) / shortest;
  const capScale = Math.min(1, 1536 / longest);
  const scale = Math.min(1, Math.max(baseScale, Math.min(shortFloorScale, capScale)));
  return {
    width: Math.max(1, Math.floor(tw * scale)),
    height: Math.max(1, Math.floor(th * scale)),
  };
}

export function selectDetailPatches(
  proxy: PixelFrame,
  targetWidth: number,
  targetHeight: number,
  options?: { fullFrameMaxEdge?: number; patchSize?: number; maxPatches?: number },
): PatchRect[] {
  const tw = Math.max(1, Math.floor(targetWidth));
  const th = Math.max(1, Math.floor(targetHeight));
  const fullFrameMaxEdge = options?.fullFrameMaxEdge ?? 768;
  const maxPatches = Math.floor(options?.maxPatches ?? 2);

  if (Math.max(tw, th) <= fullFrameMaxEdge || maxPatches <= 0) {
    return [];
  }

  const patchW = Math.min(tw, Math.max(1, Math.floor(options?.patchSize ?? 384)));
  const patchH = Math.min(th, Math.max(1, Math.floor(options?.patchSize ?? 384)));
  if (patchW === tw && patchH === th) {
    return [{ x: 0, y: 0, width: patchW, height: patchH }];
  }

  const pw = proxy.width;
  const ph = proxy.height;
  if (!Number.isSafeInteger(pw) || !Number.isSafeInteger(ph) || pw < 1 || ph < 1 || proxy.data.length !== pw * ph * 4) {
    throw new Error("Proxy frame has invalid dimensions or buffer length");
  }

  const pixelCount = pw * ph;
  const luma = new Float32Array(pixelCount);
  const alpha = new Float32Array(pixelCount);
  const data = proxy.data;
  for (let p = 0, i = 0; p < pixelCount; p++, i += 4) {
    const a = data[i + 3];
    alpha[p] = a;
    luma[p] = (0.2126 * data[i] + 0.7152 * data[i + 1] + 0.0722 * data[i + 2]) * (a / 255);
  }

  const stride = pw + 1;
  const sat = new Float64Array((ph + 1) * stride);
  for (let y = 0; y < ph; y++) {
    const yPrev = Math.max(0, y - 1);
    const yNext = Math.min(ph - 1, y + 1);
    const rowOffset = y * pw;
    const prevRowOffset = yPrev * pw;
    const nextRowOffset = yNext * pw;
    const satRow = (y + 1) * stride;
    const satPrevRow = y * stride;
    let rowSum = 0;
    for (let x = 0; x < pw; x++) {
      const xPrev = Math.max(0, x - 1);
      const xNext = Math.min(pw - 1, x + 1);
      const gLx = Math.abs(luma[rowOffset + xNext] - luma[rowOffset + xPrev]);
      const gLy = Math.abs(luma[nextRowOffset + x] - luma[prevRowOffset + x]);
      const gAx = Math.abs(alpha[rowOffset + xNext] - alpha[rowOffset + xPrev]);
      const gAy = Math.abs(alpha[nextRowOffset + x] - alpha[prevRowOffset + x]);
      const gx = Math.max(gLx, gAx);
      const gy = Math.max(gLy, gAy);
      const energy = Math.sqrt(gx * gy) + 0.15 * (gx + gy);
      rowSum += energy;
      sat[satRow + x + 1] = sat[satPrevRow + x + 1] + rowSum;
    }
  }

  const winW = Math.max(1, Math.min(pw, Math.round((patchW * pw) / tw)));
  const winH = Math.max(1, Math.min(ph, Math.round((patchH * ph) / th)));
  const stepX = Math.max(1, Math.floor(winW / 4));
  const stepY = Math.max(1, Math.floor(winH / 4));
  const winArea = winW * winH;

  const xs = buildStepPositions(pw - winW, stepX);
  const ys = buildStepPositions(ph - winH, stepY);

  interface CandidatePatch {
    rect: PatchRect;
    meanEnergy: number;
  }

  const deduped = new Map<string, CandidatePatch>();
  let maxMeanEnergy = 0;

  for (const py of ys) {
    const y0 = py * stride;
    const y1 = (py + winH) * stride;
    const sy = clampInt(Math.round((py * th) / ph), 0, th - patchH);
    for (const px of xs) {
      const sum = sat[y1 + px + winW] - sat[y0 + px + winW] - sat[y1 + px] + sat[y0 + px];
      const meanEnergy = sum / winArea;
      if (meanEnergy > maxMeanEnergy) {
        maxMeanEnergy = meanEnergy;
      }
      const sx = clampInt(Math.round((px * tw) / pw), 0, tw - patchW);
      const key = `${sx},${sy}`;
      const existing = deduped.get(key);
      if (!existing || meanEnergy > existing.meanEnergy) {
        deduped.set(key, {
          rect: { x: sx, y: sy, width: patchW, height: patchH },
          meanEnergy,
        });
      }
    }
  }

  if (maxMeanEnergy <= 1e-3) {
    return buildFallbackPatches(tw, th, patchW, patchH, maxPatches);
  }

  const candidates = [...deduped.values()].sort((a, b) => {
    if (b.meanEnergy !== a.meanEnergy) return b.meanEnergy - a.meanEnergy;
    if (a.rect.y !== b.rect.y) return a.rect.y - b.rect.y;
    return a.rect.x - b.rect.x;
  });

  const patchArea = patchW * patchH;
  const selected: PatchRect[] = [];
  const aspectRatio = Math.max(tw / th, th / tw);

  if (aspectRatio >= 2.2 && maxPatches >= 2) {
    const horizontalLong = tw >= th;
    const span = horizontalLong ? tw - patchW : th - patchH;
    if (span > 0) {
      for (let seg = 0; seg < maxPatches; seg++) {
        for (const candidate of candidates) {
          if (candidate.meanEnergy <= 1e-3) break;
          const pos = horizontalLong ? candidate.rect.x : candidate.rect.y;
          const candidateSeg = Math.min(maxPatches - 1, Math.floor((pos * maxPatches) / (span + 1)));
          if (candidateSeg !== seg) continue;
          if (selected.every(existing => isNonOverlapping(existing, candidate.rect, patchArea))) {
            selected.push(candidate.rect);
            break;
          }
        }
      }
    }
  }

  for (const candidate of candidates) {
    if (selected.length >= maxPatches) break;
    if (selected.every(existing => isNonOverlapping(existing, candidate.rect, patchArea))) {
      selected.push(candidate.rect);
    }
  }

  return selected;
}

export function combineHybridScores(globalScore: number, patchScores: readonly number[]): number {
  if (patchScores.length === 0) {
    return clamp01(globalScore);
  }
  let minPatch = patchScores[0];
  for (let i = 1; i < patchScores.length; i++) {
    if (patchScores[i] < minPatch) {
      minPatch = patchScores[i];
    }
  }
  return clamp01(0.20 * globalScore + 0.80 * minPatch);
}
