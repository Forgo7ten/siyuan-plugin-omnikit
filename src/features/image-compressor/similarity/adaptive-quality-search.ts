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

export interface ProbeStepResult {
  blob: Blob;
  bytes: number;
  similarity?: number;
}

export interface AdaptiveQualitySearchOptions {
  targetSimilarity: number;
  initialQuality: number;
  minQuality?: number;
  maxQuality?: number;
  qualityTolerance?: number;
  maxEvaluations?: number;
  maxAllowedBytes?: number;
  signal?: AbortSignal;
  probeStep?: (
    quality: number,
    options: { skipEvaluateIfOversize: boolean; signal?: AbortSignal },
  ) => Promise<ProbeStepResult | { kind: "skipped"; reason: string }>;
  encode?: (quality: number, signal?: AbortSignal) => Promise<Blob | { kind: "skipped"; reason: string }>;
  evaluate?: (candidate: Blob, signal?: AbortSignal) => Promise<number>;
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
      status: "insufficient-savings";
      bestCandidate?: QualityCandidate;
      candidates: QualityCandidate[];
      converged: boolean;
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

type ProbeOutcome =
  | { kind: "evaluated"; candidate: QualityCandidate }
  | { kind: "oversize"; quality: number; blob: Blob; bytes: number };

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
 * Finds the lowest tested WebP quality that reaches the target similarity within optional byte budget.
 * Uses safeguarded secant steps inside a valid bracket with bisection fallback and monotonic byte-budget early stopping.
 */
export async function adaptiveQualitySearch(
  options: AdaptiveQualitySearchOptions,
): Promise<AdaptiveQualitySearchResult> {
  const minQuality = options.minQuality ?? 0.5;
  const maxQuality = options.maxQuality ?? 1.0;
  const tolerance = options.qualityTolerance ?? 0.02;
  const maxEvaluations = Math.max(3, Math.floor(options.maxEvaluations ?? 5));
  const target = options.targetSimilarity;
  const budget =
    typeof options.maxAllowedBytes === "number" && Number.isFinite(options.maxAllowedBytes)
      ? options.maxAllowedBytes
      : undefined;

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
  if (!options.probeStep && (!options.encode || !options.evaluate)) {
    throw new Error("Either probeStep or both encode and evaluate must be provided");
  }

  if (budget !== undefined && budget <= 0) {
    return { status: "insufficient-savings", candidates: [], converged: true };
  }

  const executeStep = options.probeStep ?? (async (quality, stepOpts) => {
    const encoded = await options.encode!(quality, stepOpts.signal);
    abortIfNeeded(stepOpts.signal);
    if (encoded && typeof encoded === "object" && "kind" in encoded && encoded.kind === "skipped") {
      return encoded;
    }
    const blob = encoded as Blob;
    if (!(blob instanceof Blob) || blob.size <= 0) {
      throw new Error("Encoder returned an empty candidate");
    }
    if (stepOpts.skipEvaluateIfOversize && budget !== undefined && blob.size > budget) {
      return { blob, bytes: blob.size };
    }
    const similarity = await options.evaluate!(blob, stepOpts.signal);
    return { blob, bytes: blob.size, similarity };
  });

  const cache = new Map<number, QualityCandidate>();
  const candidates: QualityCandidate[] = [];
  let method: QualitySearchProgress["method"] = "initial";

  const roundQuality = (requested: number): number =>
    Math.round(clamp(requested, minQuality, maxQuality) * 10000) / 10000;

  const runProbe = async (requestedQuality: number, skipEvaluateIfOversize: boolean): Promise<ProbeOutcome> => {
    abortIfNeeded(options.signal);
    const quality = roundQuality(requestedQuality);
    const cached = cache.get(quality);
    if (cached) return { kind: "evaluated", candidate: cached };

    const result = await executeStep(quality, { skipEvaluateIfOversize, signal: options.signal });
    abortIfNeeded(options.signal);
    if (result && typeof result === "object" && "kind" in result && result.kind === "skipped") {
      throw new SearchSkippedSignal(result.reason);
    }

    const step = result as ProbeStepResult;
    if (!(step.blob instanceof Blob) || step.bytes <= 0) {
      throw new Error("Encoder returned an empty candidate");
    }

    if (step.similarity === undefined) {
      if (skipEvaluateIfOversize && budget !== undefined && step.bytes > budget) {
        return { kind: "oversize", quality, blob: step.blob, bytes: step.bytes };
      }
      throw new Error("Similarity evaluator returned an invalid score");
    }

    if (!Number.isFinite(step.similarity) || step.similarity < 0 || step.similarity > 1) {
      throw new Error("Similarity evaluator returned an invalid score");
    }

    const candidate: QualityCandidate = {
      quality,
      similarity: step.similarity,
      blob: step.blob,
      bytes: step.bytes,
    };
    cache.set(quality, candidate);
    candidates.push(candidate);
    options.onProgress?.({
      round: candidates.length,
      maxRounds: maxEvaluations,
      quality,
      similarity: step.similarity,
      bytes: step.bytes,
      method,
    });
    return { kind: "evaluated", candidate };
  };

  const probe = async (requestedQuality: number): Promise<QualityCandidate> => {
    const res = await runProbe(requestedQuality, false);
    if (res.kind !== "evaluated") {
      throw new Error("Unexpected unevaluated probe result");
    }
    return res.candidate;
  };

  try {
    const initial = await probe(clamp(options.initialQuality, minQuality, maxQuality));

    if (budget !== undefined && initial.bytes > budget && initial.similarity < target) {
      return {
        status: "insufficient-savings",
        bestCandidate: initial,
        candidates,
        converged: true,
      };
    }

    let low: BracketPoint;
    let high: BracketPoint;

    if (initial.similarity >= target) {
      if (roundQuality(minQuality) === initial.quality) {
        if (budget !== undefined && initial.bytes > budget) {
          return { status: "insufficient-savings", bestCandidate: initial, candidates, converged: true };
        }
        return { status: "met", candidate: initial, candidates, converged: true };
      }

      method = "endpoint";
      const minOutcome = await runProbe(minQuality, budget !== undefined);
      if (minOutcome.kind === "oversize") {
        return {
          status: "insufficient-savings",
          bestCandidate: initial,
          candidates,
          converged: true,
        };
      }
      const minimum = minOutcome.candidate;
      if (budget !== undefined && minimum.bytes > budget) {
        return {
          status: "insufficient-savings",
          bestCandidate: initial,
          candidates,
          converged: true,
        };
      }
      if (minimum.similarity >= target) {
        const qualifying = candidates.filter(
          c => c.similarity >= target && (budget === undefined || c.bytes <= budget),
        );
        const best = qualifying.reduce(betterCandidate);
        return { status: "met", candidate: best, candidates, converged: true };
      }
      low = minimum;
      high = initial;
    } else {
      if (roundQuality(maxQuality) === initial.quality) {
        return { status: "unreachable", bestCandidate: initial, candidates, converged: false };
      }
      method = "endpoint";
      const maximum = await probe(maxQuality);
      if (maximum.similarity < target) {
        const bestCandidate = candidates.reduce((a, b) => (a.similarity >= b.similarity ? a : b));
        return { status: "unreachable", bestCandidate, candidates, converged: false };
      }
      low = initial;
      high = maximum;
    }

    const hasQualifyingCandidate = (): boolean =>
      candidates.some(c => c.similarity >= target && (budget === undefined || c.bytes <= budget));

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
      if (budget !== undefined && next.bytes > budget && next.similarity < target && !hasQualifyingCandidate()) {
        return {
          status: "insufficient-savings",
          bestCandidate: next,
          candidates,
          converged: true,
        };
      }

      const nonMonotonic =
        next.similarity < low.similarity - 0.002 || next.similarity > high.similarity + 0.002;
      if (next.similarity >= target) {
        high = next;
      } else {
        low = next;
      }
      if (nonMonotonic) forceBisection = true;
    }

    const converged = high.quality - low.quality <= tolerance;
    const qualifying = candidates.filter(
      c => c.similarity >= target && (budget === undefined || c.bytes <= budget),
    );
    if (qualifying.length === 0) {
      const metSimilarity = candidates.filter(c => c.similarity >= target);
      const bestCandidate = metSimilarity.length > 0
        ? metSimilarity.reduce(betterCandidate)
        : candidates[candidates.length - 1];
      return {
        status: "insufficient-savings",
        bestCandidate,
        candidates,
        converged,
      };
    }

    const best = qualifying.reduce(betterCandidate);
    return {
      status: "met",
      candidate: best,
      candidates,
      converged,
    };
  } catch (error) {
    if (error instanceof SearchSkippedSignal) {
      return { status: "skipped", reason: error.reason, candidates };
    }
    throw error;
  }
}
