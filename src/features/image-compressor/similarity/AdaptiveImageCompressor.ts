import { combineSignals } from "../../../core/host/ProtyleAdapter.ts";
import { adaptiveQualitySearch, type QualitySearchProgress } from "./adaptive-quality-search.ts";
import { SimilarityWorkerSession, type WorkerFactory } from "./SimilarityWorkerSession.ts";
import { getSimilarityPolicy } from "./similarity-policy.ts";
import type { CompressionMode } from "../policy/contracts.ts";
import { outputName } from "../policy/source.ts";
import {
  computeTargetDimensions,
  inspectImage,
  probeSmartCompressionSupport,
  toAbortError,
  validateEncodeInput,
  verifyBitmap,
  type EncodeOptions,
  type EncodeResult,
  type ImageCodec,
  type ImageInfo,
} from "../services/image.ts";
import type { ImageConfig } from "../policy/parseImageConfig.ts";

export interface AdaptiveImageCompressorOptions {
  workerFactory?: WorkerFactory;
  decode?: typeof verifyBitmap;
}

const OUTPUT_VERIFY_MAX_EDGE = 64;

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
 * Opt-in adaptive quality search wrapping an underlying ImageCodec (e.g. CanvasWebpEncoder).
 * When smartEnabled is false (or the host lacks Worker/OffscreenCanvas/WebP support), delegates
 * to the fixed-quality codec. When smartEnabled is true, runs single-session co-aligned WebP
 * encoding and hybrid MS-SSIM evaluation in an inline Worker.
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

    if (!this.options.workerFactory) {
      const support = await probeSmartCompressionSupport();
      if (!support.supported) {
        const fallbackConfig: ImageConfig = {
          ...config,
          compression: { ...config.compression, smartEnabled: false },
        };
        return this.codec.encode(blob, name, fallbackConfig, signal, onProgress, mode, options);
      }
    }

    const validated = await validateEncodeInput(blob, name, config, mode, signal, options.originalInfo);
    if (validated.kind === "skipped") return validated;
    const originalInfo = validated.info;
    const c = config.compression;
    const target = computeTargetDimensions(originalInfo.width, originalInfo.height, mode, c.manualMaxEdge);

    const enforceSavings = options.enforceSavings !== false && mode !== "manual-dialog";
    let maxAllowedBytes: number | undefined;
    if (enforceSavings) {
      const requiredSaving = Math.max(1, c.minSavingBytes, Math.ceil(blob.size * c.minSavingRatio));
      maxAllowedBytes = blob.size - requiredSaving;
      if (maxAllowedBytes <= 0) {
        return {
          kind: "skipped",
          reason: "insufficient-savings",
          originalBytes: blob.size,
        };
      }
    }

    const policy = getSimilarityPolicy();
    const budgetMs = Number.isFinite(c.maxEncodeMs) && c.maxEncodeMs > 0 ? c.maxEncodeMs : 45_000;
    const deadlineController = new AbortController();
    const deadlineTimer = setTimeout(() => {
      deadlineController.abort(new Error("Encode deadline exceeded"));
    }, budgetMs);
    const effectiveSignal = combineSignals(signal, deadlineController.signal) ?? deadlineController.signal;

    const verifyCandidateBlob = async (candidateBlob: Blob): Promise<ImageInfo> => {
      if (effectiveSignal.aborted) throw toAbortError(effectiveSignal);
      if (candidateBlob.type !== "image/webp") {
        throw new Error("WebP encoding is not supported by the current host engine");
      }
      if (!candidateBlob.size || candidateBlob.size > c.maxInputBytes) {
        throw new Error("Encoder returned an invalid format/size");
      }
      const actual = inspectImage(new Uint8Array(await candidateBlob.arrayBuffer()));
      if (actual.mime !== "image/webp" || actual.animated) {
        throw new Error("Encoder output signature mismatch");
      }
      const decode = this.options.decode ?? verifyBitmap;
      const dimensions = await decode(candidateBlob, effectiveSignal, OUTPUT_VERIFY_MAX_EDGE);
      if (
        !dimensions.width ||
        !dimensions.height ||
        !actual.width ||
        !actual.height ||
        Math.abs(actual.width - target.width) > 1 ||
        Math.abs(actual.height - target.height) > 1
      ) {
        throw new Error("Unexpected output dimensions");
      }
      return actual;
    };

    let worker: SimilarityWorkerSession | undefined;

    try {
      const session = new SimilarityWorkerSession({
        signal: effectiveSignal,
        workerFactory: this.options.workerFactory,
      });
      worker = session;
      await raceAbort(
        session.initSession(blob, target.width, target.height, {
          fullFrameMaxEdge: policy.fullFrameMaxEdge,
          globalMaxEdge: policy.globalMaxEdge,
          patchSize: policy.patchSize,
          patchCount: policy.patchCount,
        }),
        effectiveSignal,
      );

      const targetSimilarity = config.compression.targetSimilarity ?? 0.99;
      const search = await raceAbort(
        adaptiveQualitySearch({
          targetSimilarity,
          initialQuality: policy.startQuality,
          minQuality: policy.minQuality,
          maxQuality: policy.maxQuality,
          qualityTolerance: policy.qualityTolerance,
          maxEvaluations: policy.maxEvaluations,
          maxAllowedBytes: enforceSavings ? maxAllowedBytes : undefined,
          signal: effectiveSignal,
          probeStep: (quality, stepOpts) =>
            session.encodeAndEvaluate(quality, {
              maxAllowedBytes: enforceSavings ? maxAllowedBytes : undefined,
              skipEvaluateIfOversize: stepOpts.skipEvaluateIfOversize,
            }),
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

      if (search.status === "insufficient-savings") {
        return {
          kind: "skipped",
          reason: "insufficient-savings",
          originalBytes: blob.size,
          ...(search.bestCandidate ? { compressedBytes: search.bestCandidate.bytes } : {}),
          smart: {
            quality: search.bestCandidate?.quality,
            similarity: search.bestCandidate?.similarity,
            targetSimilarity,
            searchRounds,
          },
        };
      }

      if (search.status === "unreachable") {
        if (mode === "manual-dialog") {
          const actual = await verifyCandidateBlob(search.bestCandidate.blob);
          const file = new File([search.bestCandidate.blob], outputName(name), { type: "image/webp" });
          return {
            kind: "encoded",
            value: {
              file,
              originalBytes: blob.size,
              outputBytes: file.size,
              width: actual.width,
              height: actual.height,
              quality: search.bestCandidate.quality,
              similarity: search.bestCandidate.similarity,
              targetSimilarity,
              searchRounds,
              unreachable: true,
            },
          };
        }
        return {
          kind: "skipped",
          reason: `target-similarity-unreachable:${search.bestCandidate.similarity}`,
          originalBytes: blob.size,
          smart: {
            quality: search.bestCandidate.quality,
            similarity: search.bestCandidate.similarity,
            targetSimilarity,
            searchRounds,
          },
        };
      }

      const actual = await verifyCandidateBlob(search.candidate.blob);
      const file = new File([search.candidate.blob], outputName(name), { type: "image/webp" });
      const savedBytes = blob.size - file.size;
      const savingRatio = blob.size > 0 ? savedBytes / blob.size : 0;
      if (
        enforceSavings &&
        (savedBytes < c.minSavingBytes || savedBytes <= 0 || savingRatio < c.minSavingRatio)
      ) {
        return {
          kind: "skipped",
          reason: "insufficient-savings",
          originalBytes: blob.size,
          compressedBytes: file.size,
          smart: {
            quality: search.candidate.quality,
            similarity: search.candidate.similarity,
            targetSimilarity,
            searchRounds,
          },
        };
      }

      return {
        kind: "encoded",
        value: {
          file,
          originalBytes: blob.size,
          outputBytes: file.size,
          width: actual.width,
          height: actual.height,
          quality: search.candidate.quality,
          similarity: search.candidate.similarity,
          targetSimilarity,
          searchRounds,
        },
      };
    } finally {
      clearTimeout(deadlineTimer);
      await worker?.close();
    }
  }
}
