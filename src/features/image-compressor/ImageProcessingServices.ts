import type { KernelClient } from "../../core/KernelClient.ts";
import type { ImageUI } from "./ImageTaskUI.ts";
import { digest, type AssetStore, type SingleOriginalFinalizer } from "./assets.ts";
import type { SourceReader } from "./download.ts";
import type { ImageCodec } from "./image.ts";
import type { ImageConfig, Intent } from "./parseImageConfig.ts";
import { retainOriginal } from "./parseImageConfig.ts";
import type { ReferenceService } from "./references.ts";
import { resolveSource, type ImageSource } from "./source.ts";

/** Concrete services shared by the existing image, document and upload entry points. */
export interface ImageProcessingServices {
  kernel: KernelClient;
  reader: SourceReader;
  encoder: ImageCodec;
  assets: AssetStore;
  references: ReferenceService;
  finalizer: SingleOriginalFinalizer;
  ui: ImageUI;
  origin: string;
  mobile: boolean;
  desktopFiles: boolean;
  config(): ImageConfig;
}

export interface PreparedImage {
  source: ImageSource;
  path: string;
  originalHash: string;
  originalBytes: number;
  compressedBytes: number;
}

/** Prepare one source without touching document references. */
export async function prepareImage(
  services: ImageProcessingServices,
  source: ImageSource,
  rootID: string,
  intent: Intent,
  config: ImageConfig,
  signal: AbortSignal,
  providedFile?: File,
): Promise<PreparedImage | undefined> {
  const readOptions = {
    maxBytes: config.compression.maxInputBytes,
    timeoutMs: 30_000,
    signal,
    ...(providedFile ? { providedFiles: new Map([[source.key, providedFile]]) } : {}),
  };
  const original = await services.reader.read(source, readOptions);
  const originalHash = await digest(original.blob);
  const encoded = await services.encoder.encode(original.blob, original.name, config, signal);
  if (encoded.kind === "skipped") return undefined;
  if (source.kind !== "asset" && retainOriginal(intent, config)) {
    await services.assets.archive(new File([original.blob], original.name, { type: original.blob.type }), rootID, signal);
  }
  const path = await services.assets.upload(encoded.value.file, rootID, signal);
  const returned = resolveSource(path, services.origin);
  const actual = await services.reader.read(returned, readOptions);
  if (await digest(actual.blob) !== await digest(encoded.value.file)) throw new Error("Uploaded image bytes differ from the encoded file");
  return { source, path, originalHash, originalBytes: original.blob.size, compressedBytes: encoded.value.file.size };
}
