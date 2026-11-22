import { combineSignals } from "../../../core/host/ProtyleAdapter.ts";
import { adaptiveQualitySearch, type QualitySearchProgress } from "./adaptive-quality-search.ts";
import { SimilarityWorkerSession, type WorkerFactory } from "./SimilarityWorkerSession.ts";
import { getSimilarityPolicy } from "./similarity-policy.ts";
import type { CompressionMode } from "../policy/contracts.ts";
import {
  toAbortError,
  validateEncodeInput,
  type EncodeOptions,
  type EncodeResult,
  type ImageCodec,
} from "../services/image.ts";
import type { ImageConfig } from "../policy/parseImageConfig.ts";

export interface AdaptiveImageCompressorOptions {
  workerFactory?: WorkerFactory;
}

function raceAbort<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) {
    void promise.catch(() => undefined);
    return Promise.reject(toAbortError(signal));
  }
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const onAbort = () => {
      if (settled) return;
      settled = true;
      void promise.catch(() => undefined);
      reject(toAbortError(signal));
    };
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      value => {
        if (!settled) {
          settled = true;
          signal.removeEventListener("abort", onAbort);
          resolve(value);
        }
      },
      error => {
        if (!settled) {
          settled = true;
          signal.removeEventListener("abort", onAbort);
          reject(error);
        }
      },
    );
  });
}

/**
 * Opt-in adaptive quality search wrapping an underlying ImageCodec (e.g. BicEncoder).
 * When smartEnabled is false, delegates directly to the underlying codec.
 * When smartEnabled is true, conducts an MS-SSIM bounded search across quality levels,
 * enforcing the 4 KiB / 5% dual savings threshold, a bounded overall time budget, and
 * returning unreachable if the target similarity cannot be achieved.
 */
export class AdaptiveImageCompressor implements ImageCodec {
  readonly name = "adaptive-ms-ssim";

  constructor(
    private readonly codec: ImageCodec,
    private readonly options: AdaptiveImageCompressorOptions = {},
  ) {}

  async encode(
    blob: Blob,
    name: string,
    config: ImageConfig,
    signal?: AbortSignal,
    onProgress?: (n: number) => void,
    mode: CompressionMode = "auto",
    options: EncodeOptions = {},
  ): Promise<EncodeResult> {
    if (!config.compression.smartEnabled) {
      return this.codec.encode(blob, name, config, signal, onProgress, mode, options);
    }

    const validated = await validateEncodeInput(blob, name, config, mode, signal, options.originalInfo);
    if (validated.kind === "skipped") return validated;
    const originalInfo = validated.info;
    const c = config.compression;

    const policy = getSimilarityPolicy();
    const budgetMs = Number.isFinite(c.maxEncodeMs) && c.maxEncodeMs > 0 ? c.maxEncodeMs : 45_000;
    const deadlineController = new AbortController();
    const deadlineTimer = setTimeout(() => {
      deadlineController.abort(new Error("Encode deadline exceeded"));
    }, budgetMs);
    const effectiveSignal = combineSignals(signal, deadlineController.signal) ?? deadlineController.signal;

    let worker: SimilarityWorkerSession | undefined;
    const encodedByQuality = new Map<number, Extract<EncodeResult, { kind: "encoded" }>["value"]>();

    try {
      const session = new SimilarityWorkerSession({
        signal: effectiveSignal,
        workerFactory: this.options.workerFactory,
      });
      worker = session;
      await raceAbort(
        session.initOriginal(blob, policy.benchmarkMaxEdge, {
          width: originalInfo.width,
          height: originalInfo.height,
        }),
        effectiveSignal,
      );

      const targetSimilarity = config.compression.targetSimilarity ?? 0.99;
      const search = await raceAbort(
        adaptiveQualitySearch({
          targetSimilarity,
          initialQuality: config.compression.initialQuality,
          minQuality: policy.minQuality,
          maxQuality: policy.maxQuality,
          qualityTolerance: policy.qualityTolerance,
          maxEvaluations: policy.maxEvaluations,
          signal: effectiveSignal,
          encode: async (quality, stepSignal) => {
            const tunedConfig: ImageConfig = {
              ...config,
              compression: { ...config.compression, initialQuality: quality },
            };
            const encoded = await this.codec.encode(
              blob,
              name,
              tunedConfig,
              stepSignal ?? effectiveSignal,
              onProgress,
              mode,
              {
                enforceSavings: false,
                originalInfo,
              },
            );
            if (encoded.kind === "skipped") {
              return { kind: "skipped", reason: encoded.reason };
            }
            encodedByQuality.set(quality, encoded.value);
            return encoded.value.file;
          },
          evaluate: candidate => session.evaluate(candidate),
          onProgress: options.onSearchProgress as (progress: QualitySearchProgress) => void,
        }),
        effectiveSignal,
      );

      if (search.status === "skipped") {
        return { kind: "skipped", reason: search.reason };
      }

      const searchRounds = search.candidates.map(candidate => ({
        quality: candidate.quality,
        similarity: candidate.similarity,
        bytes: candidate.bytes,
      }));

      if (search.status === "unreachable") {
        return {
          kind: "skipped",
          reason: `target-similarity-unreachable:${search.bestCandidate.similarity}`,
          originalBytes: blob.size,
          smart: {
            quality: search.bestCandidate.quality,
            similarity: search.bestCandidate.similarity,
            targetSimilarity: config.compression.targetSimilarity,
            searchRounds,
          },
        };
      }

      const encoded = encodedByQuality.get(search.candidate.quality);
      if (!encoded) {
        throw new Error("Selected adaptive candidate is missing its encoded metadata");
      }

      const savedBytes = blob.size - encoded.file.size;
      const savingRatio = blob.size > 0 ? savedBytes / blob.size : 0;
      const enforceSavings = options.enforceSavings !== false && mode !== "manual-dialog";
      if (
        enforceSavings &&
        (savedBytes < config.compression.minSavingBytes ||
          savedBytes <= 0 ||
          savingRatio < config.compression.minSavingRatio)
      ) {
        return {
          kind: "skipped",
          reason: "insufficient-savings",
          originalBytes: blob.size,
          compressedBytes: encoded.file.size,
          smart: {
            quality: search.candidate.quality,
            similarity: search.candidate.similarity,
            targetSimilarity: config.compression.targetSimilarity,
            searchRounds,
          },
        };
      }

      return {
        kind: "encoded",
        value: {
          ...encoded,
          quality: search.candidate.quality,
          similarity: search.candidate.similarity,
          targetSimilarity: config.compression.targetSimilarity,
          searchRounds,
        },
      };
    } finally {
      clearTimeout(deadlineTimer);
      worker?.dispose();
    }
  }
}
