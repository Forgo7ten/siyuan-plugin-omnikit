import { combineSignals } from "../../../core/host/ProtyleAdapter.ts";
import { adaptiveQualitySearch, type QualitySearchProgress } from "./adaptive-quality-search.ts";
import { SimilarityWorkerSession, type WorkerFactory } from "./SimilarityWorkerSession.ts";
import { getSimilarityPolicy } from "./similarity-policy.ts";
import type { CompressionMode } from "../policy/contracts.ts";
import { isProtectedDrawingPath, isWebpAllowed } from "../policy/ImageCandidateClassifier.ts";
import { inspectImage, type EncodeOptions, type EncodeResult, type ImageCodec } from "../services/image.ts";
import type { ImageConfig } from "../policy/parseImageConfig.ts";

export interface AdaptiveImageCompressorOptions {
  workerFactory?: WorkerFactory;
}

const SUPPORTED_STATIC_EXTS = new Set(["png", "jpg", "jpeg", "webp"]);

function withDeadline<T>(
  promise: Promise<T>,
  deadlineAt: number,
  signal?: AbortSignal,
): Promise<T> {
  const remaining = deadlineAt - Date.now();
  if (remaining <= 0) {
    void promise.catch(() => undefined);
    return Promise.reject(new Error("Encode deadline exceeded"));
  }
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener("abort", onAbort);
      void promise.catch(() => undefined);
      reject(new Error("Encode deadline exceeded"));
    }, remaining);
    const onAbort = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      void promise.catch(() => undefined);
      reject(signal?.reason ?? new DOMException("Operation cancelled", "AbortError"));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
    promise.then(
      value => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
        resolve(value);
      },
      error => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
        reject(error);
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

    const c = config.compression;
    const ext = name.split(/[?#]/)[0].split(".").pop()?.toLowerCase() ?? "";
    if (
      isProtectedDrawingPath(name) ||
      (c.excludedExtensions.includes(ext) && !isWebpAllowed(ext, mode, c.smartEnabled === true))
    ) {
      return { kind: "skipped", reason: "protected-extension" };
    }
    if (ext !== "" && !SUPPORTED_STATIC_EXTS.has(ext)) {
      return { kind: "skipped", reason: "unsupported-format" };
    }
    if (mode !== "manual-dialog" && blob.size < c.minInputBytes) {
      return { kind: "skipped", reason: "below_threshold" };
    }
    if (blob.size > c.maxInputBytes) {
      return { kind: "skipped", reason: "exceeds_max_bytes" };
    }
    if (signal?.aborted) {
      throw new DOMException("Operation cancelled", "AbortError");
    }

    const originalInfo = options.originalInfo ?? inspectImage(new Uint8Array(await blob.arrayBuffer()));
    if (originalInfo.animated) {
      return { kind: "skipped", reason: "animation-protected" };
    }
    const declared = blob.type.split(";")[0].toLowerCase();
    if (declared.startsWith("image/") && declared !== originalInfo.mime) {
      throw new Error("Image MIME/signature mismatch");
    }
    const expected: Record<string, string> = { jpg: "image/jpeg", jpeg: "image/jpeg", png: "image/png", webp: "image/webp" };
    if (expected[ext] && expected[ext] !== originalInfo.mime) {
      throw new Error("Image extension/signature mismatch");
    }
    if (!Number.isSafeInteger(originalInfo.width * originalInfo.height) || originalInfo.width * originalInfo.height > c.maxPixels) {
      throw new Error("Decoded pixel limit exceeded");
    }

    const policy = getSimilarityPolicy();
    const budgetMs = Number.isFinite(c.maxEncodeMs) && c.maxEncodeMs > 0 ? c.maxEncodeMs : 45_000;
    const deadlineAt = Date.now() + budgetMs;
    const deadlineController = new AbortController();
    const deadlineTimer = setTimeout(() => {
      deadlineController.abort(new Error("Encode deadline exceeded"));
    }, budgetMs);
    const effectiveSignal = combineSignals(signal, deadlineController.signal) ?? deadlineController.signal;

    const worker = new SimilarityWorkerSession({
      signal: effectiveSignal,
      workerFactory: this.options.workerFactory,
    });
    const encodedByQuality = new Map<number, Extract<EncodeResult, { kind: "encoded" }>["value"]>();

    try {
      await withDeadline(
        worker.initOriginal(blob, policy.benchmarkMaxEdge, {
          width: originalInfo.width,
          height: originalInfo.height,
        }),
        deadlineAt,
        effectiveSignal,
      );

      const targetSimilarity = config.compression.targetSimilarity ?? 0.99;
      const search = await withDeadline(
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
            const encoded = await withDeadline(
              this.codec.encode(blob, name, tunedConfig, stepSignal ?? effectiveSignal, onProgress, mode, {
                enforceSavings: false,
                originalInfo,
              }),
              deadlineAt,
              stepSignal ?? effectiveSignal,
            );
            if (encoded.kind === "skipped") {
              return { kind: "skipped", reason: encoded.reason };
            }
            encodedByQuality.set(quality, encoded.value);
            return encoded.value.file;
          },
          evaluate: (candidate, stepSignal) => withDeadline(
            worker.evaluate(candidate),
            deadlineAt,
            stepSignal ?? effectiveSignal,
          ),
          onProgress: options.onSearchProgress as (progress: QualitySearchProgress) => void,
        }),
        deadlineAt,
        effectiveSignal,
      );

      if (search.status === "skipped") {
        return { kind: "skipped", reason: search.reason };
      }

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
      clearTimeout(deadlineTimer);
      worker.dispose();
    }
  }
}
