import { toAbortError } from "../services/image.ts";

export interface QualityCandidate {
  quality: number;
  similarity: number;
  blob: Blob;
  bytes: number;
}

export interface QualitySearchProgress {
  round: number;
  maxRounds: number;
  quality: number;
  similarity: number;
  bytes: number;
  method: "initial" | "endpoint" | "secant" | "bisection";
}

export interface AdaptiveQualitySearchOptions {
  targetSimilarity: number;
  initialQuality: number;
  minQuality?: number;
  maxQuality?: number;
  qualityTolerance?: number;
  maxEvaluations?: number;
  signal?: AbortSignal;
  encode: (quality: number, signal?: AbortSignal) => Promise<Blob | { kind: "skipped"; reason: string }>;
  evaluate: (candidate: Blob, signal?: AbortSignal) => Promise<number>;
  onProgress?: (progress: QualitySearchProgress) => void;
}

export type AdaptiveQualitySearchResult =
  | {
      status: "met";
      candidate: QualityCandidate;
      candidates: QualityCandidate[];
      converged: boolean;
    }
  | {
      status: "unreachable";
      bestCandidate: QualityCandidate;
      candidates: QualityCandidate[];
      converged: false;
    }
  | {
      status: "skipped";
      reason: string;
      candidates: QualityCandidate[];
    };

class SearchSkippedSignal extends Error {
  constructor(readonly reason: string) {
    super(reason);
    this.name = "SearchSkippedSignal";
  }
}

interface BracketPoint extends QualityCandidate {}

function abortIfNeeded(signal?: AbortSignal): void {
  if (signal?.aborted) throw toAbortError(signal);
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function betterCandidate(a: QualityCandidate, b: QualityCandidate): QualityCandidate {
  if (a.bytes !== b.bytes) return a.bytes < b.bytes ? a : b;
  if (a.similarity !== b.similarity) return a.similarity > b.similarity ? a : b;
  return a.quality < b.quality ? a : b;
}

/**
 * Finds the lowest tested WebP quality that reaches the target similarity.
 * A safeguarded secant step is used inside a valid bracket; bisection is the fallback
 * for unsafe or non-monotonic interpolation.
 *
 * Early stopping redline: Only candidates that have achieved similarity >= targetSimilarity
 * may qualify. When even maxQuality (1.00) cannot reach target, returns unreachable status.
 */
export async function adaptiveQualitySearch(
  options: AdaptiveQualitySearchOptions,
): Promise<AdaptiveQualitySearchResult> {
  const minQuality = options.minQuality ?? 0.1;
  const maxQuality = options.maxQuality ?? 1.0;
  const tolerance = options.qualityTolerance ?? 0.01;
  const maxEvaluations = Math.max(3, Math.floor(options.maxEvaluations ?? 7));
  const target = options.targetSimilarity;

  if (!Number.isFinite(target) || target <= 0 || target > 1) {
    throw new Error("targetSimilarity must be in (0, 1]");
  }
  if (
    !Number.isFinite(minQuality) ||
    !Number.isFinite(maxQuality) ||
    minQuality < 0.01 ||
    maxQuality > 1 ||
    minQuality >= maxQuality
  ) {
    throw new Error("Invalid quality search interval");
  }
  if (!Number.isFinite(options.initialQuality)) {
    throw new Error("initialQuality must be finite");
  }

  const cache = new Map<number, QualityCandidate>();
  const candidates: QualityCandidate[] = [];
  let method: QualitySearchProgress["method"] = "initial";

  const roundQuality = (requested: number): number =>
    Math.round(clamp(requested, minQuality, maxQuality) * 10000) / 10000;

  const probe = async (requestedQuality: number): Promise<QualityCandidate> => {
    abortIfNeeded(options.signal);
    const quality = roundQuality(requestedQuality);
    const cached = cache.get(quality);
    if (cached) return cached;

    const encoded = await options.encode(quality, options.signal);
    abortIfNeeded(options.signal);
    if (encoded && typeof encoded === "object" && "kind" in encoded && encoded.kind === "skipped") {
      throw new SearchSkippedSignal(encoded.reason);
    }
    const blob = encoded as Blob;
    if (!(blob instanceof Blob) || blob.size <= 0) {
      throw new Error("Encoder returned an empty candidate");
    }

    const similarity = await options.evaluate(blob, options.signal);
    abortIfNeeded(options.signal);
    if (!Number.isFinite(similarity) || similarity < 0 || similarity > 1) {
      throw new Error("Similarity evaluator returned an invalid score");
    }

    const candidate: QualityCandidate = { quality, similarity, blob, bytes: blob.size };
    cache.set(quality, candidate);
    candidates.push(candidate);
    options.onProgress?.({
      round: candidates.length,
      maxRounds: maxEvaluations,
      quality,
      similarity,
      bytes: blob.size,
      method,
    });
    return candidate;
  };

  try {
    const initial = await probe(clamp(options.initialQuality, minQuality, maxQuality));
    let low: BracketPoint;
    let high: BracketPoint;

    if (initial.similarity >= target) {
      method = "endpoint";
      const minimum = await probe(minQuality);
      if (minimum.similarity >= target) {
        const qualifying = candidates.filter(c => c.similarity >= target);
        const best = qualifying.reduce(betterCandidate);
        return { status: "met", candidate: best, candidates, converged: true };
      }
      low = minimum;
      high = initial;
    } else {
      method = "endpoint";
      const maximum = await probe(maxQuality);
      if (maximum.similarity < target) {
        const bestCandidate = candidates.reduce((a, b) => (a.similarity >= b.similarity ? a : b));
        return { status: "unreachable", bestCandidate, candidates, converged: false };
      }
      low = initial;
      high = maximum;
    }

    let forceBisection = false;
    while (candidates.length < maxEvaluations && high.quality - low.quality > tolerance) {
      abortIfNeeded(options.signal);
      const range = high.quality - low.quality;
      const denominator = high.similarity - low.similarity;
      const secantQuality =
        denominator > 1e-9
          ? low.quality + ((target - low.similarity) * range) / denominator
          : Number.NaN;
      const margin = range * 0.1;
      const safeSecant =
        Number.isFinite(secantQuality) &&
        secantQuality > low.quality + margin &&
        secantQuality < high.quality - margin;

      let nextQuality = !forceBisection && safeSecant ? secantQuality : (low.quality + high.quality) / 2;
      method = !forceBisection && safeSecant ? "secant" : "bisection";
      forceBisection = false;

      let roundedNext = roundQuality(nextQuality);
      if (roundedNext <= low.quality || roundedNext >= high.quality) {
        method = "bisection";
        nextQuality = (low.quality + high.quality) / 2;
        roundedNext = roundQuality(nextQuality);
        if (roundedNext <= low.quality || roundedNext >= high.quality) {
          break;
        }
      }

      const next = await probe(roundedNext);
      const nonMonotonic =
        next.similarity < low.similarity - 0.002 || next.similarity > high.similarity + 0.002;
      if (next.similarity >= target) {
        high = next;
      } else {
        low = next;
      }
      if (nonMonotonic) forceBisection = true;
    }

    const qualifying = candidates.filter(c => c.similarity >= target);
    const best = qualifying.reduce(betterCandidate);
    return {
      status: "met",
      candidate: best,
      candidates,
      converged: high.quality - low.quality <= tolerance,
    };
  } catch (error) {
    if (error instanceof SearchSkippedSignal) {
      return { status: "skipped", reason: error.reason, candidates };
    }
    throw error;
  }
}
