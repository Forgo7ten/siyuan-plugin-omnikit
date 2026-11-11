import imageCompression from "browser-image-compression";
import { createCompressionFile } from "./CompressionFile.ts";
import { checkEligibility, isWorthReplacing } from "./ImageEligibility.ts";
import { imageDefaults, type ImageSettings } from "./settings.ts";

export { createCompressionFile } from "./CompressionFile.ts";

export interface CompressedImage {
  blob: Blob;
  originalBytes: number;
  compressedBytes: number;
}

export type CompressionDiagnostic =
  | { stage: "eligibility"; accepted: boolean; reason?: string; format?: string }
  | { stage: "replacement"; replaced: boolean; reason?: string; originalBytes: number; outputBytes: number; minSavingRatio: number };

function localWorkerLibraryURL(): string {
  // @compat Vite's CJS library output cannot rely on import.meta.url in the browser.
  // The official SiYuan plugin asset route is checked on desktop AND mobile.
  return new URL(
    "/plugins/siyuan-plugin-omnikit/browser-image-compression.js",
    location.origin,
  ).href;
}

/**
 * @safety The compression Worker uses a packaged local asset, not a public CDN.
 * @invariant No replacement unless WebP is smaller by the configured threshold.
 */
export class ImageCompressorService {
  constructor(
    private readonly compressImage: typeof imageCompression = imageCompression,
    private readonly localLibURL: string = localWorkerLibraryURL(),
  ) {}

  async compress(
    source: Blob,
    sourcePath: string,
    settings: ImageSettings,
    signal?: AbortSignal,
    onDiagnostic?: (diagnostic: CompressionDiagnostic) => void,
  ): Promise<CompressedImage | undefined> {
    if (signal?.aborted) throw new DOMException("Compression cancelled", "AbortError");
    const config = { ...imageDefaults, ...settings };
    const eligibility = await checkEligibility(source as Blob & { name?: string }, config, sourcePath);
    onDiagnostic?.({
      stage: "eligibility",
      accepted: eligibility.accepted,
      reason: eligibility.reason,
      format: eligibility.format,
    });
    if (!eligibility.accepted || signal?.aborted) return undefined;
    const inputFile = createCompressionFile(source, sourcePath);
    const output = await this.compressImage(inputFile, {
      fileType: "image/webp",
      initialQuality: config.quality,
      maxWidthOrHeight: config.maxDimension,
      useWebWorker: true,
      libURL: this.localLibURL,
      signal,
      preserveExif: false,
    });
    if (signal?.aborted) throw new DOMException("Compression cancelled", "AbortError");
    const worthReplacing = isWorthReplacing(source.size, output.size, config.minSavingRatio);
    if (output.type !== "image/webp" || !worthReplacing) {
      onDiagnostic?.({
        stage: "replacement",
        replaced: false,
        reason: output.type !== "image/webp" ? "output-not-webp" : "below-minimum-savings",
        originalBytes: source.size,
        outputBytes: output.size,
        minSavingRatio: config.minSavingRatio,
      });
      return undefined;
    }
    onDiagnostic?.({
      stage: "replacement",
      replaced: true,
      originalBytes: source.size,
      outputBytes: output.size,
      minSavingRatio: config.minSavingRatio,
    });
    return { blob: output, originalBytes: source.size, compressedBytes: output.size };
  }
}
