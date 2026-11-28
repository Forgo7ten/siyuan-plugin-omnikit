import { isAbortError } from "../../../core/feedback/UiFeedback.ts";
import { describeError } from "../../../core/host/describeError.ts";
import type { KernelClient } from "../../../core/host/KernelClient.ts";
import { Logger } from "../../../core/host/Logger.ts";
import type { ImageUI } from "../ui/ImageTaskUI.ts";
import type { AssetStore } from "./assets.ts";
import type { SourceReader } from "./download.ts";
import {
  inspectImage,
  isSmartCompressionEffective,
  type ImageCodec,
  type ImageInfo,
  type SmartSearchSummary,
} from "./image.ts";
import type { ImageConfig } from "../policy/parseImageConfig.ts";
import type { ReferenceService } from "./SafeBlockWriter.ts";
import type { ImageCompressionRecordStore } from "../store/ImageCompressionRecordStore.ts";
import type { CompressionMode, OccurrenceTarget } from "../policy/contracts.ts";
import { resolveSource, type ImageSource } from "../policy/source.ts";
import { classifyImageCandidate } from "../policy/ImageCandidateClassifier.ts";
import { formatBytes, formatCompressionRatio } from "../policy/formatStats.ts";

export interface CompressionMetrics {
  originalBytes?: number;
  compressedBytes?: number;
  quality?: number;
  similarity?: number;
  targetSimilarity?: number;
  searchRounds?: Array<{ quality: number; similarity: number; bytes: number }>;
}

/** Concrete services shared by the existing image, document and upload entry points. */
export interface ImageProcessingServices {
  kernel: KernelClient;
  reader: SourceReader;
  encoder: ImageCodec;
  assets: AssetStore;
  references: ReferenceService;
  records: ImageCompressionRecordStore;
  recordsReady: Promise<void>;
  logger?: Pick<Logger, "info">;
  compressOccurrence(target: OccurrenceTarget, config: ImageConfig, signal: AbortSignal,
    options?: { replace?: boolean; mode?: CompressionMode; providedFile?: File }): Promise<OccurrenceCompressionResult>;
  savePreview(target: OccurrenceTarget, encodedFile: File, signal: AbortSignal,
    replace: boolean, metrics?: CompressionMetrics): Promise<OccurrenceCompressionResult>;
  ui: ImageUI;
  origin: string;
  mobile: boolean;
  userAgent: () => string;
  config(): ImageConfig;
}

export interface PreparedImage {
  source: ImageSource;
  originalPath: string;
  path: string;
  originalBytes: number;
  compressedBytes: number;
  quality?: number;
  similarity?: number;
  targetSimilarity?: number;
  searchRounds?: Array<{ quality: number; similarity: number; bytes: number }>;
}

export type OccurrenceCompressionResult =
  | { status: "skipped" }
  | {
      status: "saved";
      path: string;
      reference: "not-requested" | "replaced" | "conflict" | "aborted" | "failed" | "unknown";
      originalBytes?: number;
      compressedBytes?: number;
      quality?: number;
      similarity?: number;
      targetSimilarity?: number;
      searchRounds?: Array<{ quality: number; similarity: number; bytes: number }>;
    };

const COPY_PROMPT_THROTTLE_MS = 5_000;
const lastCopyPromptByServices = new WeakMap<object, number>();

function formatAssetPath(source: Extract<ImageSource, { kind: "asset" }>): string {
  return source.kernelPath;
}

function normalizedAssetPath(rawPath: string, origin: string): string {
  const source = resolveSource(rawPath, origin);
  if (source.kind !== "asset") throw new Error("Compression original must be a local asset");
  return formatAssetPath(source);
}

/** Prepare one source without touching document references. */
export async function prepareImage(
  services: ImageProcessingServices,
  source: ImageSource,
  rootID: string,
  mode: CompressionMode,
  config: ImageConfig,
  signal: AbortSignal,
  providedFile?: File,
): Promise<PreparedImage | undefined> {
  if (source.kind !== "asset") throw new Error("Remote images must be localized before compression");
  const decision = classifyImageCandidate({
    path: source.raw,
    mode,
    excludedExtensions: config.compression.excludedExtensions,
    smartEnabled: isSmartCompressionEffective(config.compression.smartEnabled),
  });
  const originalPath = formatAssetPath(source);
  if (!decision.eligible) {
    logSkippedImage(services, originalPath, mode, decision.reason);
    return undefined;
  }

  const readOptions = {
    maxBytes: config.compression.maxInputBytes,
    timeoutMs: 30_000,
    signal,
    userAgent: services.userAgent(),
    ...(providedFile ? { providedFiles: new Map([[source.key, providedFile]]) } : {}),
  };
  const original = await services.reader.read(source, readOptions);
  const encoded = await services.encoder.encode(original.blob, original.name, config, signal, undefined, mode);
  if (encoded.kind === "skipped") {
    logSkippedImage(services, originalPath, mode, encoded.reason, {
      originalBytes: encoded.originalBytes ?? original.blob.size,
      compressedBytes: encoded.compressedBytes,
      smart: encoded.smart,
    });
    return undefined;
  }
  const path = await persistMappedAsset(services, originalPath, encoded.value.file, rootID, signal);
  return {
    source,
    originalPath,
    path,
    originalBytes: original.blob.size,
    compressedBytes: encoded.value.file.size,
    quality: encoded.value.quality,
    similarity: encoded.value.similarity,
    targetSimilarity: encoded.value.targetSimilarity,
    searchRounds: encoded.value.searchRounds,
  };
}

/** Uploads an encoded or localized asset and persists its record mapping before any block reference write. */
export async function persistMappedAsset(
  services: ImageProcessingServices,
  recordSource: string,
  encodedFile: File,
  rootID: string,
  signal: AbortSignal,
): Promise<string> {
  const path = await services.assets.upload(encodedFile, rootID, signal);
  try {
    await services.recordsReady;
    await services.records.upsert(recordSource, path);
  } catch (error) {
    const now = Date.now();
    const lastPrompt = lastCopyPromptByServices.get(services) ?? 0;
    if (now - lastPrompt >= COPY_PROMPT_THROTTLE_MS) {
      lastCopyPromptByServices.set(services, now);
      services.ui.copyablePath(path);
    }
    throw new RecordPersistenceError(path, error);
  }
  return path;
}

export function safeFileName(name: string): string {
  const base = name.replace(/\\/g, "/").split("/").pop() || "remote-image";
  const safe = base.replace(/[\u0000-\u001f<>:"/\\|?*]/g, "_").slice(0, 180);
  return safe || "remote-image";
}

const MIME_TO_EXT: Record<ImageInfo["mime"], string> = {
  "image/png": ".png",
  "image/jpeg": ".jpg",
  "image/webp": ".webp",
};

/** Calibrates extension and MIME from image signature bytes when supported, keeping other formats intact. */
export async function calibrateRemoteImageFile(blob: Blob, rawName: string): Promise<File> {
  const baseName = safeFileName(rawName);
  let fileName = baseName;
  let mime = blob.type;
  try {
    const info = inspectImage(new Uint8Array(await blob.arrayBuffer()));
    mime = info.mime;
    const targetExt = MIME_TO_EXT[info.mime];
    const extMatch = /\.[a-zA-Z0-9]{1,10}$/.exec(baseName);
    const currentExt = extMatch?.[0].toLowerCase();
    const compatibleExts = info.mime === "image/jpeg" ? [".jpg", ".jpeg"] : [targetExt];
    if (!currentExt || !compatibleExts.includes(currentExt)) {
      const stem = extMatch ? baseName.slice(0, -extMatch[0].length) : baseName;
      fileName = `${stem || "remote-image"}${targetExt}`;
    }
  } catch {
    // Preserve original file name and MIME for GIF/SVG or truncated test stubs
  }
  return new File([blob], fileName, { type: mime });
}

export async function assertImagePayload(blob: Blob): Promise<void> {
  const bytes = new Uint8Array(await blob.slice(0, 4096).arrayBuffer());
  const ascii = (start: number, length: number) => String.fromCharCode(...bytes.slice(start, start + length));
  const png = bytes.length >= 8 && [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]
    .every((byte, index) => bytes[index] === byte);
  const jpeg = bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
  const gif = bytes.length >= 6 && ["GIF87a", "GIF89a"].includes(ascii(0, 6));
  const webp = bytes.length >= 12 && ascii(0, 4) === "RIFF" && ascii(8, 4) === "WEBP";
  const prefix = new TextDecoder().decode(bytes).replace(/^\uFEFF/, "").trimStart();
  const svg = /^(?:<\?xml[^>]*>\s*)?<svg(?:\s|>)/i.test(prefix);
  if (svg) {
    const fullText = await blob.text();
    if (/<!DOCTYPE|<!ENTITY|<script\b|<foreignObject\b|<image\b|<use\b|<iframe\b|<object\b|<embed\b|<style\b|\son[a-z]+\s*=|\b(?:href|src)\s*=|url\s*\(|@import|(?:javascript|data|file):/i.test(fullText)) {
      throw new Error("Unsafe SVG image content");
    }
  }
  if (!png && !jpeg && !gif && !webp && !svg) throw new Error("Remote response is not a supported image payload");
}

/**
 * Downloads and calibrates a remote image (unless a calibrated file is already provided),
 * uploads it to SiYuan `assets/`, and persists the `remoteURL -> localPath` record before returning.
 */
export async function localizeRemoteAsset(
  services: ImageProcessingServices,
  source: Extract<ImageSource, { kind: "remote" }>,
  rootID: string,
  signal: AbortSignal,
  calibratedFile?: File,
): Promise<{ localPath: string; file: File }> {
  if (signal.aborted) throw new DOMException("Aborted", "AbortError");
  let file: File;
  if (calibratedFile) {
    file = calibratedFile;
  } else {
    const config = services.config();
    const downloaded = await services.reader.read(source, {
      maxBytes: Math.min(config.compression.maxInputBytes, 32 * 1024 * 1024),
      timeoutMs: 30_000,
      signal,
      userAgent: services.userAgent(),
    });
    await assertImagePayload(downloaded.blob);
    if (signal.aborted) throw new DOMException("Aborted", "AbortError");
    file = await calibrateRemoteImageFile(downloaded.blob, downloaded.name || source.name);
  }
  const localPath = await persistMappedAsset(services, source.url, file, rootID, signal);
  return { localPath, file };
}

/** Persistence is a mandatory gate for every compressed-reference write. */
export async function compressOccurrence(
  services: ImageProcessingServices,
  target: OccurrenceTarget,
  config: ImageConfig,
  signal: AbortSignal,
  options: { replace?: boolean; mode?: CompressionMode; providedFile?: File } = {},
): Promise<OccurrenceCompressionResult> {
  if (signal.aborted) throw new DOMException("Aborted", "AbortError");
  const source = resolveSource(target.oldPath, services.origin);
  if (source.kind !== "asset") throw new Error("Image must be a localized asset before compression");
  const mode = options.mode ?? "auto";
  try {
    const prepared = await prepareImage(services, source, target.rootID, mode, config, signal, options.providedFile);
    if (!prepared) return { status: "skipped" };
    return await finishSaved(services, target, prepared.path, prepared.originalPath, signal, options.replace ?? false, mode, {
      originalBytes: prepared.originalBytes,
      compressedBytes: prepared.compressedBytes,
      quality: prepared.quality,
      similarity: prepared.similarity,
      targetSimilarity: prepared.targetSimilarity,
      searchRounds: prepared.searchRounds,
    });
  } catch (error) {
    if (!signal.aborted && !isAbortError(error)) {
      logFailedImage(services, formatAssetPath(source), mode, error);
    }
    throw error;
  }
}

export async function savePreview(
  services: ImageProcessingServices,
  target: OccurrenceTarget,
  encodedFile: File,
  signal: AbortSignal,
  replace: boolean,
  metrics?: CompressionMetrics,
): Promise<OccurrenceCompressionResult> {
  const originalPath = normalizedAssetPath(target.oldPath, services.origin);
  try {
    const path = await persistMappedAsset(services, originalPath, encodedFile, target.rootID, signal);
    return await finishSaved(services, target, path, originalPath, signal, replace, "manual-dialog", metrics);
  } catch (error) {
    if (!signal.aborted && !isAbortError(error)) {
      logFailedImage(services, originalPath, "manual-dialog", error);
    }
    throw error;
  }
}

export function logSkippedImage(
  services: Pick<ImageProcessingServices, "logger"> | undefined,
  originalPath: string,
  mode: CompressionMode,
  reason: string,
  details?: { originalBytes?: number; compressedBytes?: number; smart?: SmartSearchSummary },
): void {
  const logger = services?.logger ?? Logger.shared;
  const payload: Record<string, unknown> = {
    status: "skipped",
    mode,
    sourcePath: originalPath,
    reason,
  };
  if (details?.originalBytes !== undefined) {
    payload.originalBytes = details.originalBytes;
    if (details.compressedBytes !== undefined) {
      payload.compressedBytes = details.compressedBytes;
      payload.sizeChange = `${formatBytes(details.originalBytes)} -> ${formatBytes(details.compressedBytes)}`;
      payload.compressionRatio = formatCompressionRatio(details.originalBytes, details.compressedBytes);
    } else {
      payload.originalSize = formatBytes(details.originalBytes);
    }
  }
  if (details?.smart) {
    payload.smart = details.smart;
  }
  logger.info?.("图片压缩跳过", payload);
}

export function logReferenceStatus(
  services: Pick<ImageProcessingServices, "logger"> | undefined,
  entry: {
    mode: CompressionMode;
    blockID: string;
    imageOrdinal: number;
    sourcePath: string;
    compressedPath: string;
    reference: "replaced" | "conflict" | "failed" | "unknown";
    reason?: string;
  },
): void {
  const logger = services?.logger ?? Logger.shared;
  logger.info?.("图片引用更新状态", {
    mode: entry.mode,
    blockID: entry.blockID,
    imageOrdinal: entry.imageOrdinal,
    sourcePath: entry.sourcePath,
    compressedPath: entry.compressedPath,
    reference: entry.reference,
    ...(entry.reason !== undefined ? { reason: entry.reason } : {}),
  });
}

function logFailedImage(
  services: ImageProcessingServices,
  originalPath: string,
  mode: CompressionMode,
  error: unknown,
): void {
  const logger = services.logger ?? Logger.shared;
  logger.info("图片压缩失败", {
    status: "failed",
    mode,
    sourcePath: originalPath,
    error: describeError(error),
  });
}

function logCompressedImage(
  services: ImageProcessingServices,
  originalPath: string,
  compressedPath: string,
  reference: string,
  mode: CompressionMode,
  metrics?: CompressionMetrics,
): void {
  const logger = services.logger ?? Logger.shared;
  const payload: Record<string, unknown> = {
    status: "saved",
    mode,
    sourcePath: originalPath,
    compressedPath,
    reference,
  };
  if (metrics?.originalBytes !== undefined && metrics?.compressedBytes !== undefined) {
    payload.originalBytes = metrics.originalBytes;
    payload.compressedBytes = metrics.compressedBytes;
    payload.sizeChange = `${formatBytes(metrics.originalBytes)} -> ${formatBytes(metrics.compressedBytes)}`;
    payload.compressionRatio = formatCompressionRatio(metrics.originalBytes, metrics.compressedBytes);
  }
  if (metrics?.similarity !== undefined) {
    payload.smart = {
      quality: metrics.quality,
      similarity: metrics.similarity,
      ...(metrics.targetSimilarity !== undefined ? { targetSimilarity: metrics.targetSimilarity } : {}),
      ...(metrics.searchRounds !== undefined ? { searchRounds: metrics.searchRounds } : {}),
    };
  } else if (metrics?.quality !== undefined) {
    payload.quality = metrics.quality;
  }
  logger.info("图片压缩完成", payload);
}

async function finishSaved(
  services: ImageProcessingServices, target: OccurrenceTarget, path: string,
  originalPath: string, signal: AbortSignal, replace: boolean, mode: CompressionMode,
  metrics?: CompressionMetrics,
): Promise<OccurrenceCompressionResult> {
  const reference = !replace
    ? "not-requested"
    : signal.aborted
      ? "aborted"
      : await services.references.commitOccurrence(target, path, signal);
  if (replace && reference !== "aborted") {
    await services.records.markOperation(
      originalPath,
      path,
      reference === "replaced" ? "replaced" : "incomplete",
    ).catch(() => undefined);
  }
  logCompressedImage(services, originalPath, path, reference, mode, metrics);
  const result: OccurrenceCompressionResult = { status: "saved", path, reference };
  if (metrics?.originalBytes !== undefined) result.originalBytes = metrics.originalBytes;
  if (metrics?.compressedBytes !== undefined) result.compressedBytes = metrics.compressedBytes;
  if (metrics?.quality !== undefined) result.quality = metrics.quality;
  if (metrics?.similarity !== undefined) result.similarity = metrics.similarity;
  if (metrics?.targetSimilarity !== undefined) result.targetSimilarity = metrics.targetSimilarity;
  if (metrics?.searchRounds !== undefined) result.searchRounds = metrics.searchRounds;
  return result;
}

export class RecordPersistenceError extends Error {
  constructor(readonly uploadedPath: string, cause: unknown) {
    super(`Compression record could not be saved for ${uploadedPath}`, { cause });
  }
}
