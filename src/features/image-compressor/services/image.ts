import { outputName } from "../policy/source.ts";
import type { CompressionMode } from "../policy/contracts.ts";
import { extractImageExtension, isProtectedDrawingPath, isWebpAllowed } from "../policy/ImageCandidateClassifier.ts";
import { WEBP_MAX_DIMENSION } from "../policy/parseImageConfig.ts";
import { inspectImage, type ImageInfo } from "./imageHeaderInspector.ts";

export { WEBP_MAX_DIMENSION };
export { inspectImage, type ImageInfo } from "./imageHeaderInspector.ts";
export {
  getCachedSmartCompressionSupport,
  isSmartCompressionEffective,
  probeSmartCompressionSupport,
  setSmartSupportResolverForTest,
  type SmartCompressionSupport,
  type SmartSupportReason,
} from "./smartCompressionProbe.ts";

export interface CompressionOptions {
  initialQuality: number;
  manualMaxEdge: number;
  minInputBytes: number;
  minSavingBytes: number;
  minSavingRatio: number;
  maxInputBytes: number;
  maxPixels: number;
  maxEncodeMs: number;
  excludedExtensions: string[];
  smartEnabled?: boolean;
  targetSimilarity?: number;
}

export interface ImageConfig {
  compression: CompressionOptions;
}

export function computeTargetDimensions(
  width: number,
  height: number,
  mode: CompressionMode,
  manualMaxEdge: number,
): { width: number; height: number } {
  if (mode === "auto" || mode === "document") {
    return { width, height };
  }
  const longest = Math.max(1, width, height);
  const maxEdge = Math.min(manualMaxEdge, longest);
  const scale = Math.min(1, maxEdge / longest);
  return {
    width: Math.max(1, Math.floor(width * scale)),
    height: Math.max(1, Math.floor(height * scale)),
  };
}

export interface RawWebpEncodeRequest {
  width: number;
  height: number;
  quality: number;
  signal: AbortSignal;
}

export type RawWebpEncodeFn = (blob: Blob, request: RawWebpEncodeRequest) => Promise<Blob>;

export interface EncodedImage {
  file: File;
  originalBytes: number;
  outputBytes: number;
  width: number;
  height: number;
  quality?: number;
  similarity?: number;
  targetSimilarity?: number;
  searchRounds?: Array<{ quality: number; similarity: number; bytes: number }>;
  unreachable?: boolean;
}

export interface SmartSearchSummary {
  quality?: number;
  similarity?: number;
  targetSimilarity?: number;
  searchRounds?: Array<{ quality: number; similarity: number; bytes: number }>;
}

export type EncodeResult =
  | { kind: "encoded"; value: EncodedImage }
  | {
      kind: "skipped";
      reason: string;
      originalBytes?: number;
      compressedBytes?: number;
      smart?: SmartSearchSummary;
    };

export interface EncodeOptions {
  enforceSavings?: boolean;
  onSearchProgress?: (progress: any) => void;
  originalInfo?: ImageInfo;
}

/**
 * ImageCodec: Plug-in interface for image compression / transcoding.
 * Allows painless addition of WebAssembly (e.g. libwebp) or native codecs in the future.
 */
export interface ImageCodec {
  readonly name: string;
  encode(
    blob: Blob,
    name: string,
    config: ImageConfig,
    signal?: AbortSignal,
    onProgress?: (n: number) => void,
    mode?: CompressionMode,
    options?: EncodeOptions,
  ): Promise<EncodeResult>;
}

const OUTPUT_VERIFY_MAX_EDGE = 64;

export function toAbortError(signal: AbortSignal): unknown {
  if (signal.reason instanceof Error) return signal.reason;
  return new DOMException(typeof signal.reason === "string" ? signal.reason : "Operation cancelled", "AbortError");
}

export type EncodeValidationResult =
  | { kind: "valid"; info: ImageInfo }
  | { kind: "skipped"; reason: string };

export async function validateEncodeInput(
  blob: Blob,
  name: string,
  config: ImageConfig,
  mode: CompressionMode,
  signal?: AbortSignal,
  originalInfo?: ImageInfo,
): Promise<EncodeValidationResult> {
  if (signal?.aborted) throw toAbortError(signal);
  const c = config.compression;
  const ext = extractImageExtension(name);
  const webpAllowed = isWebpAllowed(ext, mode, c.smartEnabled === true);
  if (isProtectedDrawingPath(name) ||
      (c.excludedExtensions.includes(ext) && !webpAllowed)) {
    return { kind: "skipped", reason: "protected-extension" };
  }
  if (ext !== "" && !["png", "jpg", "jpeg", "webp"].includes(ext)) {
    return { kind: "skipped", reason: "unsupported-format" };
  }
  if (mode !== "manual-dialog" && blob.size < c.minInputBytes) {
    return { kind: "skipped", reason: "below_threshold" };
  }
  if (blob.size > c.maxInputBytes) {
    throw new Error("Input exceeds byte limit");
  }

  const info = originalInfo ?? inspectImage(new Uint8Array(await blob.arrayBuffer()));
  if (signal?.aborted) throw toAbortError(signal);
  if (info.animated) return { kind: "skipped", reason: "animation-protected" };
  const declared = blob.type.split(";")[0].toLowerCase();
  if (declared.startsWith("image/") && declared !== info.mime) {
    throw new Error("Image MIME/signature mismatch");
  }

  const expected: Record<string, string> = { jpg: "image/jpeg", jpeg: "image/jpeg", png: "image/png", webp: "image/webp" };
  if (expected[ext] && expected[ext] !== info.mime) {
    throw new Error("Image extension/signature mismatch");
  }
  if (info.mime === "image/webp" && !isWebpAllowed("webp", mode, c.smartEnabled === true)) {
    return { kind: "skipped", reason: "protected-extension" };
  }
  if (!Number.isSafeInteger(info.width * info.height) || info.width * info.height > c.maxPixels) {
    throw new Error("Decoded pixel limit exceeded");
  }
  const target = computeTargetDimensions(info.width, info.height, mode, c.manualMaxEdge);
  if (target.width > WEBP_MAX_DIMENSION || target.height > WEBP_MAX_DIMENSION) {
    return { kind: "skipped", reason: "dimension-limit-exceeded" };
  }
  return { kind: "valid", info };
}

export async function verifyBitmap(blob: Blob, signal?: AbortSignal, maxEdge?: number): Promise<{ width: number; height: number }> {
  if (signal?.aborted) throw toAbortError(signal);
  if (typeof createImageBitmap === "function") {
    const options = typeof maxEdge === "number" && maxEdge > 0
      ? { resizeWidth: maxEdge, resizeHeight: maxEdge, resizeQuality: "low" as const }
      : undefined;
    const bitmap = options
      ? await createImageBitmap(blob, options)
      : await createImageBitmap(blob);
    try {
      if (signal?.aborted) throw toAbortError(signal);
      return { width: bitmap.width, height: bitmap.height };
    } finally {
      bitmap.close();
    }
  }
  const objectURL = URL.createObjectURL(blob);
  try {
    return await new Promise((resolve, reject) => {
      const image = new Image();
      const cleanup = () => {
        signal?.removeEventListener("abort", cancel);
        image.onload = null;
        image.onerror = null;
        image.src = "";
      };
      const cancel = () => {
        cleanup();
        reject(signal ? toAbortError(signal) : new DOMException("Operation cancelled", "AbortError"));
      };
      image.onload = () => { const result = { width: image.naturalWidth, height: image.naturalHeight }; cleanup(); resolve(result); };
      image.onerror = () => { cleanup(); reject(new Error("Image decoder rejected output")); };
      signal?.addEventListener("abort", cancel, { once: true });
      if (signal?.aborted) cancel(); else image.src = objectURL;
    });
  } finally {
    URL.revokeObjectURL(objectURL);
  }
}

async function loadHtmlImage(blob: Blob, signal: AbortSignal): Promise<HTMLImageElement> {
  if (signal.aborted) throw toAbortError(signal);
  const objectURL = URL.createObjectURL(blob);
  try {
    return await new Promise<HTMLImageElement>((resolve, reject) => {
      const image = new Image();
      const cleanup = () => {
        signal.removeEventListener("abort", cancel);
        image.onload = null;
        image.onerror = null;
      };
      const cancel = () => {
        cleanup();
        image.src = "";
        reject(toAbortError(signal));
      };
      image.onload = () => {
        cleanup();
        resolve(image);
      };
      image.onerror = () => {
        cleanup();
        reject(new Error("Image decoder failed to decode source"));
      };
      signal.addEventListener("abort", cancel, { once: true });
      if (signal.aborted) cancel();
      else image.src = objectURL;
    });
  } finally {
    URL.revokeObjectURL(objectURL);
  }
}

export async function defaultCanvasWebpEncode(blob: Blob, request: RawWebpEncodeRequest): Promise<Blob> {
  const { width, height, quality, signal } = request;
  if (signal.aborted) throw toAbortError(signal);

  if (typeof OffscreenCanvas === "function" && typeof createImageBitmap === "function") {
    const canvas = new OffscreenCanvas(width, height);
    const ctx = canvas.getContext("2d");
    if (ctx) {
      const bitmap = await createImageBitmap(blob);
      let bitmapClosed = false;
      const closeBitmap = () => {
        if (!bitmapClosed) {
          bitmapClosed = true;
          bitmap.close();
        }
      };
      try {
        if (signal.aborted) throw toAbortError(signal);
        ctx.imageSmoothingEnabled = true;
        ctx.imageSmoothingQuality = "high";
        ctx.drawImage(bitmap, 0, 0, width, height);
        closeBitmap();
        if (signal.aborted) throw toAbortError(signal);
        const encoded = await canvas.convertToBlob({ type: "image/webp", quality });
        if (encoded && encoded.type === "image/webp" && encoded.size > 0) {
          return encoded;
        }
      } finally {
        closeBitmap();
        canvas.width = 0;
        canvas.height = 0;
      }
    } else {
      canvas.width = 0;
      canvas.height = 0;
    }
  }

  if (typeof document !== "undefined" && typeof document.createElement === "function") {
    const canvas = document.createElement("canvas");
    try {
      canvas.width = width;
      canvas.height = height;
      const ctx = canvas.getContext("2d");
      if (!ctx) throw new Error("HTMLCanvasElement 2D context unavailable");
      ctx.imageSmoothingEnabled = true;
      ctx.imageSmoothingQuality = "high";

      if (typeof createImageBitmap === "function") {
        const bitmap = await createImageBitmap(blob);
        let bitmapClosed = false;
        const closeBitmap = () => {
          if (!bitmapClosed) {
            bitmapClosed = true;
            bitmap.close();
          }
        };
        try {
          if (signal.aborted) throw toAbortError(signal);
          ctx.drawImage(bitmap, 0, 0, width, height);
          closeBitmap();
        } finally {
          closeBitmap();
        }
      } else {
        const image = await loadHtmlImage(blob, signal);
        if (signal.aborted) throw toAbortError(signal);
        ctx.drawImage(image, 0, 0, width, height);
      }

      if (signal.aborted) throw toAbortError(signal);
      return await new Promise<Blob>((resolve, reject) => {
        let settled = false;
        const onAbort = () => {
          if (settled) return;
          settled = true;
          reject(toAbortError(signal));
        };
        signal.addEventListener("abort", onAbort, { once: true });
        canvas.toBlob(
          encoded => {
            if (settled) return;
            settled = true;
            signal.removeEventListener("abort", onAbort);
            if (!encoded) {
              reject(new Error("Canvas toBlob returned null"));
            } else {
              resolve(encoded);
            }
          },
          "image/webp",
          quality,
        );
      });
    } finally {
      canvas.width = 0;
      canvas.height = 0;
    }
  }

  throw new Error("Canvas WebP encoding is unavailable in the current environment");
}

/**
 * Zero-dependency native Canvas WebP encoder (OffscreenCanvas primary, HTMLCanvasElement fallback).
 * Encodes strictly once at the requested quality without hidden iterative quality degradation.
 */
export class CanvasWebpEncoder implements ImageCodec {
  readonly name = "canvas-webp-encoder";

  constructor(
    private readonly rawEncode: RawWebpEncodeFn = defaultCanvasWebpEncode,
    private readonly decode = verifyBitmap,
  ) {}

  async encode(
    blob: Blob,
    name: string,
    config: ImageConfig,
    signal?: AbortSignal,
    _onProgress?: (n: number) => void,
    mode: CompressionMode = "auto",
    options: EncodeOptions = {},
  ): Promise<EncodeResult> {
    const validated = await validateEncodeInput(blob, name, config, mode, signal, options.originalInfo);
    if (validated.kind === "skipped") return validated;
    const info = validated.info;
    const c = config.compression;
    const expected = computeTargetDimensions(info.width, info.height, mode, c.manualMaxEdge);

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new Error("Encode deadline exceeded")), c.maxEncodeMs);
    const relay = () => controller.abort(signal ? toAbortError(signal) : new DOMException("Operation cancelled", "AbortError"));
    if (signal?.aborted) relay();
    else signal?.addEventListener("abort", relay, { once: true });

    try {
      const output = await this.rawEncode(blob, {
        width: expected.width,
        height: expected.height,
        quality: c.initialQuality,
        signal: controller.signal,
      });

      if (controller.signal.aborted) throw toAbortError(controller.signal);
      if (output.type !== "image/webp") {
        return { kind: "skipped", reason: "webp-encode-unsupported" };
      }
      if (!output.size || output.size > c.maxInputBytes) {
        throw new Error("Encoder returned an invalid format/size");
      }
      const actual = inspectImage(new Uint8Array(await output.arrayBuffer()));
      if (actual.mime !== "image/webp" || actual.animated) throw new Error("Encoder output signature mismatch");

      const dimensions = await this.decode(output, controller.signal, OUTPUT_VERIFY_MAX_EDGE);
      if (
        !dimensions.width ||
        !dimensions.height ||
        !actual.width ||
        !actual.height ||
        Math.abs(actual.width - expected.width) > 1 ||
        Math.abs(actual.height - expected.height) > 1
      ) {
        throw new Error("Unexpected output dimensions");
      }

      const saved = blob.size - output.size;
      const enforceSavings = options.enforceSavings !== false && mode !== "manual-dialog";
      if (enforceSavings && (saved < c.minSavingBytes || saved <= 0 || saved / blob.size < c.minSavingRatio)) {
        return { kind: "skipped", reason: "insufficient-savings", originalBytes: blob.size, compressedBytes: output.size };
      }

      return {
        kind: "encoded",
        value: {
          file: new File([output], outputName(name), { type: "image/webp" }),
          originalBytes: blob.size,
          outputBytes: output.size,
          quality: c.initialQuality,
          width: actual.width,
          height: actual.height,
        },
      };
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener("abort", relay);
    }
  }
}
