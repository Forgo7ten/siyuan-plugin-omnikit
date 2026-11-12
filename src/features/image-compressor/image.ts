import { outputName } from "./source.ts";

export interface CompressionOptions {
  initialQuality: number;
  maxDimension: number;
  minInputBytes: number;
  minSavingBytes: number;
  minSavingRatio: number;
  maxInputBytes: number;
  maxPixels: number;
  maxEncodeMs: number;
  excludedExtensions: string[];
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
    let p = 2, w = 0, h = 0;
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
      if ([192, 193, 194].includes(marker)) {
        if (n < 8 || ![1, 3].includes(b[p + 7])) throw new Error("Unsupported JPEG colour components");
        h = v.getUint16(p + 3);
        w = v.getUint16(p + 5);
      }
      p += n;
    }
    if (!w || !h) throw new Error("Unsupported/incomplete JPEG");
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
}

export type EncodeResult =
  | { kind: "encoded"; value: EncodedImage }
  | { kind: "skipped"; reason: string };

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
  ): Promise<EncodeResult>;
}

export async function verifyBitmap(blob: Blob, signal?: AbortSignal): Promise<{ width: number; height: number }> {
  if (signal?.aborted) throw new DOMException("Operation cancelled", "AbortError");
  if (typeof createImageBitmap === "function") {
    const bitmap = await createImageBitmap(blob);
    try {
      if (signal?.aborted) throw new DOMException("Operation cancelled", "AbortError");
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
      const cancel = () => { cleanup(); reject(new DOMException("Cancelled", "AbortError")); };
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
  ): Promise<EncodeResult> {
    if (signal?.aborted) throw new DOMException("Operation cancelled", "AbortError");
    const c = config.compression;
    const ext = name.split(/[?#]/)[0].split(".").pop()?.toLowerCase() ?? "";
    if (/excalidraw|(?:^|[\/\\])drawings?[\/\\._-]/i.test(name) || c.excludedExtensions.includes(ext)) {
      return { kind: "skipped", reason: "protected-extension" };
    }
    if (blob.size < c.minInputBytes) return { kind: "skipped", reason: "below-minimum-input" };
    if (blob.size > c.maxInputBytes) throw new Error("Input exceeds byte limit");

    const info = inspectImage(new Uint8Array(await blob.arrayBuffer()));
    if (info.animated) return { kind: "skipped", reason: "animation-protected" };
    const declared = blob.type.split(";")[0].toLowerCase();
    if (declared.startsWith("image/") && declared !== info.mime) throw new Error("Image MIME/signature mismatch");

    const expected: Record<string, string> = { jpg: "image/jpeg", jpeg: "image/jpeg", png: "image/png", webp: "image/webp" };
    if (expected[ext] && expected[ext] !== info.mime) throw new Error("Image extension/signature mismatch");
    if (!Number.isSafeInteger(info.width * info.height) || info.width * info.height > c.maxPixels) {
      throw new Error("Decoded pixel limit exceeded");
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new Error("Encode deadline exceeded")), c.maxEncodeMs);
    const relay = () => controller.abort(signal?.reason);
    signal?.addEventListener("abort", relay, { once: true });

    try {
      const file = new File([blob], name, { type: info.mime });
      const output = await this.bic(file, {
        fileType: "image/webp",
        initialQuality: c.initialQuality,
        maxWidthOrHeight: c.maxDimension,
        maxSizeMB: Infinity,
        maxIteration: 3,
        alwaysKeepResolution: true,
        useWebWorker: true,
        libURL: this.libURL,
        signal: controller.signal,
        preserveExif: false,
        onProgress,
      });

      if (controller.signal.aborted) throw controller.signal.reason ?? new DOMException("Cancelled", "AbortError");
      if (output.type !== "image/webp" || !output.size || output.size > c.maxInputBytes) {
        throw new Error("Encoder returned an invalid format/size");
      }
      const actual = inspectImage(new Uint8Array(await output.arrayBuffer()));
      if (actual.mime !== "image/webp" || actual.animated) throw new Error("Encoder output signature mismatch");

      const dimensions = await this.decode(output, controller.signal);
      if (!dimensions.width || !dimensions.height || dimensions.width !== actual.width || dimensions.height !== actual.height
        || Math.max(dimensions.width, dimensions.height) > c.maxDimension || dimensions.width * dimensions.height > info.width * info.height) {
        throw new Error("Unexpected output dimensions");
      }

      const saved = blob.size - output.size;
      if (saved < c.minSavingBytes || saved <= 0 || saved / blob.size < c.minSavingRatio) {
        return { kind: "skipped", reason: "insufficient-savings" };
      }

      return {
        kind: "encoded",
        value: {
          file: new File([output], outputName(name), { type: "image/webp" }),
          originalBytes: blob.size,
          outputBytes: output.size,
          ...dimensions,
        },
      };
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener("abort", relay);
    }
  }
}
