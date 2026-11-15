import type { KernelClient } from "../../../core/host/KernelClient.ts";
import type { ImageUI } from "../ui/ImageTaskUI.ts";
import { digest, type AssetStore } from "./assets.ts";
import type { SourceReader } from "./download.ts";
import type { ImageCodec } from "./image.ts";
import type { ImageConfig, Intent } from "../policy/parseImageConfig.ts";
import type { ReferenceService } from "./references.ts";
import type { ImageCompressionRecordStore } from "../store/ImageCompressionRecordStore.ts";
import type { CompressionMode, OccurrenceTarget } from "../policy/contracts.ts";
import { resolveSource, type ImageSource } from "../policy/source.ts";
import { classifyImageCandidate } from "../policy/ImageCandidateClassifier.ts";

/** Concrete services shared by the existing image, document and upload entry points. */
export interface ImageProcessingServices {
  kernel: KernelClient;
  reader: SourceReader;
  encoder: ImageCodec;
  assets: AssetStore;
  references: ReferenceService;
  records: ImageCompressionRecordStore;
  recordsReady: Promise<void>;
  compressOccurrence(target: OccurrenceTarget, config: ImageConfig, signal: AbortSignal,
    options?: { replace?: boolean; mode?: CompressionMode; providedFile?: File }): Promise<OccurrenceCompressionResult>;
  savePreview(target: OccurrenceTarget, encodedFile: File, signal: AbortSignal,
    replace: boolean): Promise<OccurrenceCompressionResult>;
  ui: ImageUI;
  origin: string;
  mobile: boolean;
  desktopFiles: boolean;
  userAgent: () => string;
  config(): ImageConfig;
}

export interface PreparedImage {
  source: ImageSource;
  path: string;
  originalBytes: number;
  compressedBytes: number;
  quality?: number;
  similarity?: number;
}

export type OccurrenceCompressionResult =
  | { status: "skipped" }
  | {
      status: "saved";
      path: string;
      reference: "not-requested" | "replaced" | "conflict" | "unknown";
      originalBytes?: number;
      compressedBytes?: number;
      quality?: number;
      similarity?: number;
    };

/** Prepare one source without touching document references. */
export async function prepareImage(
  services: ImageProcessingServices,
  source: ImageSource,
  rootID: string,
  intent: Intent,
  config: ImageConfig,
  signal: AbortSignal,
  providedFile?: File,
  selectedMode?: CompressionMode,
): Promise<PreparedImage | undefined> {
  const mode = selectedMode ?? (intent.kind === "document" ? "document" : intent.kind === "upload" || intent.kind === "remote-auto" ? "auto" : "manual-quick");
  const decision = classifyImageCandidate({
    path: source.raw,
    mode,
    excludedExtensions: config.compression.excludedExtensions,
  });
  if (!decision.eligible) return undefined;

  const readOptions = {
    maxBytes: config.compression.maxInputBytes,
    timeoutMs: 30_000,
    signal,
    userAgent: services.userAgent(),
    ...(providedFile ? { providedFiles: new Map([[source.key, providedFile]]) } : {}),
  };
  if (source.kind !== "asset") throw new Error("Remote images must be localized before compression");
  const original = await services.reader.read(source, readOptions);
  const encoded = await services.encoder.encode(original.blob, original.name, config, signal, undefined, mode);
  if (encoded.kind === "skipped") return undefined;
  const path = await persistEncodedImage(services, source.path + (source.box ? `?box=${source.box}` : ""),
    encoded.value.file, rootID, signal, config.compression.maxInputBytes);
  return {
    source,
    path,
    originalBytes: original.blob.size,
    compressedBytes: encoded.value.file.size,
    quality: encoded.value.quality,
    similarity: encoded.value.similarity,
  };
}

/** Upload, verify, and durably record one encoded asset before it can be referenced. */
export async function persistEncodedImage(
  services: ImageProcessingServices,
  originalPath: string,
  encodedFile: File,
  rootID: string,
  signal: AbortSignal,
  maxBytes: number,
): Promise<string> {
  const original = resolveSource(originalPath, services.origin);
  if (original.kind !== "asset") throw new Error("Compression original must be a local asset");
  const path = await services.assets.upload(encodedFile, rootID, signal);
  try {
    const returned = resolveSource(path, services.origin);
    const actual = await services.reader.read(returned, { maxBytes, timeoutMs: 30_000, signal });
    if (await digest(actual.blob) !== await digest(encodedFile)) throw new Error("Uploaded image bytes differ from the encoded file");
  } catch (error) {
    services.ui.copyablePath(path, "image.uploadVerificationFailed");
    throw new Error(`Uploaded image could not be verified at ${path}`, { cause: error });
  }
  try {
    await services.recordsReady;
    await services.records.upsert(originalPath, path);
  } catch (error) {
    services.ui.copyablePath(path);
    throw new RecordPersistenceError(path, error);
  }
  return path;
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
  const intent: Intent = mode === "document" ? { kind: "document", rootID: target.rootID }
    : mode === "manual-quick" || mode === "manual-dialog" ? { kind: "manual-single", rootID: target.rootID }
    : { kind: "upload", rootID: target.rootID, originalInputCount: 1 };
  const prepared = await prepareImage(services, source, target.rootID, intent, config, signal, options.providedFile, mode);
  if (!prepared) return { status: "skipped" };
  return finishSaved(services, target, prepared.path, signal, options.replace ?? false, {
    originalBytes: prepared.originalBytes,
    compressedBytes: prepared.compressedBytes,
    quality: prepared.quality,
    similarity: prepared.similarity,
  });
}

export async function savePreview(
  services: ImageProcessingServices,
  target: OccurrenceTarget,
  encodedFile: File,
  signal: AbortSignal,
  replace: boolean,
  metrics?: { originalBytes?: number; compressedBytes?: number; quality?: number; similarity?: number },
): Promise<OccurrenceCompressionResult> {
  const path = await persistEncodedImage(services, target.oldPath, encodedFile, target.rootID, signal,
    services.config().compression.maxInputBytes);
  return finishSaved(services, target, path, signal, replace, metrics);
}

async function finishSaved(
  services: ImageProcessingServices, target: OccurrenceTarget, path: string,
  signal: AbortSignal, replace: boolean,
  metrics?: { originalBytes?: number; compressedBytes?: number; quality?: number; similarity?: number },
): Promise<OccurrenceCompressionResult> {
  const reference = !replace || signal.aborted ? "not-requested" : await services.references.commitOccurrence(target, path, signal);
  if (replace && !signal.aborted) {
    await services.records.markOperation(target.oldPath, path,
      reference === "replaced" ? "replaced" : "incomplete").catch(() => undefined);
  }
  const result: OccurrenceCompressionResult = { status: "saved", path, reference };
  if (metrics?.originalBytes !== undefined) result.originalBytes = metrics.originalBytes;
  if (metrics?.compressedBytes !== undefined) result.compressedBytes = metrics.compressedBytes;
  if (metrics?.quality !== undefined) result.quality = metrics.quality;
  if (metrics?.similarity !== undefined) result.similarity = metrics.similarity;
  return result;
}

export class RecordPersistenceError extends Error {
  constructor(readonly uploadedPath: string, cause: unknown) {
    super(`Compression record could not be saved for ${uploadedPath}`, { cause });
  }
}
