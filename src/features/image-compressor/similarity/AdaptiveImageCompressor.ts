import { adaptiveQualitySearch, type QualitySearchProgress } from "./adaptive-quality-search.ts";
import { SimilarityWorkerSession, type WorkerFactory } from "./SimilarityWorkerSession.ts";
import { getSimilarityPolicy } from "./similarity-policy.ts";
import type { CompressionMode } from "../policy/contracts.ts";
import type { EncodeOptions, EncodeResult, ImageCodec } from "../services/image.ts";
import type { ImageConfig } from "../policy/parseImageConfig.ts";

export interface AdaptiveImageCompressorOptions {
  workerFactory?: WorkerFactory;
}

/**
 * Opt-in adaptive quality search wrapping an underlying ImageCodec (e.g. BicEncoder).
 * When smartEnabled is false, delegates directly to the underlying codec.
 * When smartEnabled is true, conducts an MS-SSIM bounded search across quality levels,
 * enforcing the 4 KiB / 5% dual savings threshold, and returning unreachable if the target
 * similarity cannot be achieved.
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

    const c = config.compression;
    const ext = name.split(/[?#]/)[0].split(".").pop()?.toLowerCase() ?? "";
    if (
      /excalidraw|(?:^|[\/\\])drawings?[\/\\._-]/i.test(name) ||
      (c.excludedExtensions.includes(ext) && !(ext === "webp" && mode === "manual-dialog"))
    ) {
      return { kind: "skipped", reason: "protected-extension" };
    }
    if (mode !== "manual-dialog" && blob.size < c.minInputBytes) {
      return { kind: "skipped", reason: "below_threshold" };
    }
    if (blob.size > c.maxInputBytes) {
      return { kind: "skipped", reason: "exceeds_max_bytes" };
    }

    const policy = getSimilarityPolicy();
    const worker = new SimilarityWorkerSession({
      signal,
      workerFactory: this.options.workerFactory,
    });
    const encodedByQuality = new Map<number, Extract<EncodeResult, { kind: "encoded" }>["value"]>();

    try {
      await worker.initOriginal(blob, policy.benchmarkMaxEdge);

      const targetSimilarity = config.compression.targetSimilarity ?? 0.99;
      const search = await adaptiveQualitySearch({
        targetSimilarity,
        initialQuality: config.compression.initialQuality,
        minQuality: policy.minQuality,
        maxQuality: policy.maxQuality,
        qualityTolerance: policy.qualityTolerance,
        maxEvaluations: policy.maxEvaluations,
        signal,
        encode: async quality => {
          const tunedConfig: ImageConfig = {
            ...config,
            compression: { ...config.compression, initialQuality: quality },
          };
          const encoded = await this.codec.encode(blob, name, tunedConfig, signal, onProgress, mode, {
            enforceSavings: false,
          });
          if (encoded.kind === "skipped") throw new Error(encoded.reason);
          encodedByQuality.set(quality, encoded.value);
          return encoded.value.file;
        },
        evaluate: candidate => worker.evaluate(candidate),
        onProgress: options.onSearchProgress as (progress: QualitySearchProgress) => void,
      });

      if (search.status === "unreachable") {
        return {
          kind: "skipped",
          reason: `target-similarity-unreachable:${search.bestCandidate.similarity}`,
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
        return { kind: "skipped", reason: "insufficient-savings" };
      }

      return {
        kind: "encoded",
        value: {
          ...encoded,
          quality: search.candidate.quality,
          similarity: search.candidate.similarity,
          targetSimilarity: config.compression.targetSimilarity,
          searchRounds: search.candidates.map(candidate => ({
            quality: candidate.quality,
            similarity: candidate.similarity,
            bytes: candidate.bytes,
          })),
        },
      };
    } finally {
      worker.dispose();
    }
  }
}
