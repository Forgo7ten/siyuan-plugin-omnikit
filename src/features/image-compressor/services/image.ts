import { outputName } from "../policy/source.ts";
import type { CompressionMode } from "../policy/contracts.ts";
import { extractImageExtension, isProtectedDrawingPath, isWebpAllowed } from "../policy/ImageCandidateClassifier.ts";

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

export interface ImageInfo {
  mime: "image/png" | "image/jpeg" | "image/webp";
  width: number;
  height: number;
  animated: boolean;
}

const text = (b: Uint8Array, at: number, n: number) => String.fromCharCode(...b.subarray(at, at + n));

export function inspectImage(b: Uint8Array): ImageInfo {
  const v = new DataView(b.buffer, b.byteOffset, b.byteLength);
  if ([137, 80, 78, 71, 13, 10, 26, 10].every((x, i) => b[i] === x)) {
    let p = 8, w = 0, h = 0, animated = false, data = false;
    while (p + 12 <= b.length) {
      const n = v.getUint32(p), tag = text(b, p + 4, 4);
      if (n > b.length - p - 12) throw new Error("Truncated PNG");
      if (!w && tag !== "IHDR") throw new Error("Missing PNG header");
      if (tag === "IHDR") {
        if (w || n !== 13) throw new Error("Invalid PNG header");
        w = v.getUint32(p + 8);
        h = v.getUint32(p + 12);
        if (!w || !h) throw new Error("Empty PNG dimensions");
      }
      if (["acTL", "fcTL", "fdAT"].includes(tag)) animated = true;
      if (tag === "IDAT" && n) data = true;
      if (tag === "IEND") {
        if (!data || n !== 0 || p + 12 !== b.length) throw new Error("Invalid PNG end");
        return { mime: "image/png", width: w, height: h, animated };
      }
      p += n + 12;
    }
    throw new Error("PNG is incomplete");
  }
  if (b.length >= 12 && text(b, 0, 4) === "RIFF" && text(b, 8, 4) === "WEBP") {
    if (v.getUint32(4, true) + 8 !== b.length) throw new Error("WebP length mismatch");
    let p = 12, w = 0, h = 0, animated = false, data = false;
    while (p + 8 <= b.length) {
      const tag = text(b, p, 4), n = v.getUint32(p + 4, true), q = p + 8;
      if (n > b.length - q) throw new Error("Truncated WebP");
      if (tag === "VP8X") {
        if (n !== 10) throw new Error("Invalid WebP extended header");
        animated ||= (b[q] & 2) !== 0;
        w = 1 + b[q + 4] + (b[q + 5] << 8) + (b[q + 6] << 16);
        h = 1 + b[q + 7] + (b[q + 8] << 8) + (b[q + 9] << 16);
      } else if (tag === "VP8 ") {
        if (n < 10 || text(b, q + 3, 3) !== "\x9d\x01\x2a") throw new Error("Invalid WebP frame");
        if (!w) { w = v.getUint16(q + 6, true) & 0x3fff; h = v.getUint16(q + 8, true) & 0x3fff; }
        data = true;
      } else if (tag === "VP8L") {
        if (n < 5 || b[q] !== 0x2f) throw new Error("Invalid lossless WebP frame");
        const bits = v.getUint32(q + 1, true);
        if (!w) { w = (bits & 0x3fff) + 1; h = ((bits >>> 14) & 0x3fff) + 1; }
        data = true;
      }
      if (tag === "ANIM" || tag === "ANMF") animated = true;
      p += 8 + n + (n & 1);
    }
    if (p !== b.length || !w || !h || !data && !animated) throw new Error("Invalid WebP");
    return { mime: "image/webp", width: w, height: h, animated };
  }
  if (b[0] === 255 && b[1] === 216) {
    let p = 2, w = 0, h = 0, orientation = 1;
    while (p + 1 < b.length) {
      if (b[p++] !== 255) throw new Error("Invalid JPEG marker");
      while (b[p] === 255) p++;
      const marker = b[p++];
      if (marker === 218 || marker === 217) break;
      if (marker === 1 || marker >= 208 && marker <= 215) continue;
      if (p + 2 > b.length) throw new Error("Truncated JPEG");
      const n = v.getUint16(p);
      if (n < 2 || n > b.length - p) throw new Error("Truncated JPEG segment");
      if (marker === 226 && text(b, p + 2, 4) === "MPF\0") throw new Error("Multi-picture JPEG is protected");
      if (marker === 225 && n >= 14 && text(b, p + 2, 4) === "Exif" && b[p + 6] === 0 && b[p + 7] === 0) {
        const tiffStart = p + 8;
        const isLittle = b[tiffStart] === 0x49 && b[tiffStart + 1] === 0x49;
        const isBig = b[tiffStart] === 0x4d && b[tiffStart + 1] === 0x4d;
        if ((isLittle || isBig) && v.getUint16(tiffStart + 2, isLittle) === 42) {
          const ifdOffset = v.getUint32(tiffStart + 4, isLittle);
          if (ifdOffset >= 8 && tiffStart + ifdOffset + 2 <= b.length) {
            const entries = v.getUint16(tiffStart + ifdOffset, isLittle);
            for (let i = 0; i < entries; i++) {
              const entryPos = tiffStart + ifdOffset + 2 + i * 12;
              if (entryPos + 12 > b.length) break;
              const tag = v.getUint16(entryPos, isLittle);
              if (tag === 0x0112) {
                orientation = v.getUint16(entryPos + 8, isLittle);
                break;
              }
            }
          }
        }
      }
      if ([192, 193, 194].includes(marker)) {
        if (n < 8 || ![1, 3].includes(b[p + 7])) throw new Error("Unsupported JPEG colour components");
        h = v.getUint16(p + 3);
        w = v.getUint16(p + 5);
      }
      p += n;
    }
    if (!w || !h) throw new Error("Unsupported/incomplete JPEG");
    if (orientation >= 5 && orientation <= 8) {
      const temp = w;
      w = h;
      h = temp;
    }
    return { mime: "image/jpeg", width: w, height: h, animated: false };
  }
  throw new Error("Unsupported image signature; GIF/SVG/HEIF/AVIF are not converted by this engine");
}

export interface BicOptions {
  fileType: string;
  initialQuality: number;
  maxWidthOrHeight: number;
  maxSizeMB: number;
  maxIteration: number;
  alwaysKeepResolution: boolean;
  useWebWorker: boolean;
  libURL: string;
  signal: AbortSignal;
  preserveExif: boolean;
  onProgress?: (percentage: number) => void;
}

export type BicFunction = (file: File, options: BicOptions) => Promise<Blob>;

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

/**
 * Browser-Image-Compression (Canvas/UPNG based) implementation of ImageCodec.
 * Relies on hard limits (maxDimension, maxPixels, maxInputBytes) and worker concurrency
 * instead of an artificial virtual memory quota.
 */
export class BicEncoder implements ImageCodec {
  readonly name = "bic-encoder";

  constructor(
    private readonly bic: BicFunction,
    private readonly libURL: string,
    private readonly decode = verifyBitmap,
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
    const validated = await validateEncodeInput(blob, name, config, mode, signal, options.originalInfo);
    if (validated.kind === "skipped") return validated;
    const info = validated.info;
    const c = config.compression;

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new Error("Encode deadline exceeded")), c.maxEncodeMs);
    const relay = () => controller.abort(signal ? toAbortError(signal) : new DOMException("Operation cancelled", "AbortError"));
    signal?.addEventListener("abort", relay, { once: true });

    try {
      const file = new File([blob], name, { type: info.mime });
      const output = await this.bic(file, {
        fileType: "image/webp",
        initialQuality: c.initialQuality,
        maxWidthOrHeight: (mode === "auto" || mode === "document")
          ? Math.max(info.width, info.height) : Math.min(c.manualMaxEdge, Math.max(info.width, info.height)),
        maxSizeMB: Infinity,
        maxIteration: 3,
        alwaysKeepResolution: mode === "auto" || mode === "document",
        useWebWorker: true,
        libURL: this.libURL,
        signal: controller.signal,
        preserveExif: false, // TODO: expose preserveExif once the WebP encoder reliably preserves EXIF metadata.
        onProgress,
      });

      if (controller.signal.aborted) throw toAbortError(controller.signal);
      if (output.type !== "image/webp" || !output.size || output.size > c.maxInputBytes) {
        throw new Error("Encoder returned an invalid format/size");
      }
      const actual = inspectImage(new Uint8Array(await output.arrayBuffer()));
      if (actual.mime !== "image/webp" || actual.animated) throw new Error("Encoder output signature mismatch");

      const dimensions = await this.decode(output, controller.signal, OUTPUT_VERIFY_MAX_EDGE);
      const strictDimensions = mode === "auto" || mode === "document";
      const expectedMaxEdge = strictDimensions ? Math.max(info.width, info.height)
        : Math.min(c.manualMaxEdge, Math.max(info.width, info.height));
      const expectedScale = Math.min(1, expectedMaxEdge / Math.max(info.width, info.height));
      const expectedWidth = Math.max(1, Math.floor(info.width * expectedScale));
      const expectedHeight = Math.max(1, Math.floor(info.height * expectedScale));
      if (!dimensions.width || !dimensions.height || !actual.width || !actual.height
        || Math.abs(actual.width - expectedWidth) > 1 || Math.abs(actual.height - expectedHeight) > 1) {
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
