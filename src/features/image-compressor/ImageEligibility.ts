import type { ImageSettings } from "./settings.ts";
import { hasExcludedExtension } from "./ExcludedExtensions.ts";

export interface EligibilityResult {
  accepted: boolean;
  reason?: string;
  format?: "image/jpeg" | "image/png" | "image/webp";
}

const drawingAsset = /(?:^|[\\/])(?:excalidraw|drawings?)(?:[\\/]|[-_.])/i;

/** Cheap name/path gate used before fetching assets; content is verified asynchronously below. */
export function isEligibleImage(name: string, type = "", settings?: Partial<ImageSettings>): boolean {
  const path = name.toLowerCase();
  const mime = type.toLowerCase();
  if ((/^excalidraw-/i.test(name) || drawingAsset.test(name))) return false;
  if (settings?.excludedExtensions && hasExcludedExtension(name, settings.excludedExtensions)) return false;
  // GIF and SVG stay hard-protected: re-encoding animated GIF drops frames and
  // rasterizing SVG destroys vector content, even if removed from the extra blacklist.
  if (/\.gif(?:$|[?#])/i.test(path) || mime === "image/gif") return false;
  if (/\.svg(?:$|[?#])/i.test(path) || mime === "image/svg+xml") return false;
  const png = /\.png(?:$|[?#])/i.test(path) || mime === "image/png";
  const jpeg = /\.jpe?g(?:$|[?#])/i.test(path) || mime === "image/jpeg";
  const webp = /\.webp(?:$|[?#])/i.test(path) || mime === "image/webp";
  if (!png && !jpeg && !webp) return false;
  if (mime && mime !== "image/png" && mime !== "image/jpeg" && mime !== "image/webp") return false;
  return true;
}

/**
 * @safety MIME type and extension are hints only. Only verified JPEG/PNG/WebP signatures
 * reach the decoder; SVG, animated formats, and drawing assets remain untouched.
 */
export async function checkEligibility(
  file: Blob & { name?: string },
  settings: Pick<ImageSettings, "minSizeBytes"> & Partial<ImageSettings>,
  sourcePath = file.name ?? "",
): Promise<EligibilityResult> {
  const name = sourcePath || file.name || "";
  if (!isEligibleImage(name, file.type, settings)) return { accepted: false, reason: "Unsupported or protected image" };
  if (file.size < settings.minSizeBytes) return { accepted: false, reason: "Too small" };

  const bytes = new Uint8Array(await file.slice(0, 12).arrayBuffer());
  if (isPng(bytes)) {
    if (file.type && file.type !== "image/png") return { accepted: false, reason: "MIME and PNG signature disagree" };
    if (/\.jpe?g(?:$|[?#])/i.test(name)) return { accepted: false, reason: "Extension and PNG signature disagree" };
    return { accepted: true, format: "image/png" };
  }
  if (isJpeg(bytes)) {
    if (file.type && file.type !== "image/jpeg") return { accepted: false, reason: "MIME and JPEG signature disagree" };
    if (/\.png(?:$|[?#])/i.test(name)) return { accepted: false, reason: "Extension and JPEG signature disagree" };
    return { accepted: true, format: "image/jpeg" };
  }
  if (isWebp(bytes)) {
    if (file.type && file.type !== "image/webp") return { accepted: false, reason: "MIME and WebP signature disagree" };
    if (/\.(?:png|jpe?g)(?:$|[?#])/i.test(name)) return { accepted: false, reason: "Extension and WebP signature disagree" };
    return { accepted: true, format: "image/webp" };
  }
  return { accepted: false, reason: "Unrecognized image signature" };
}

export function isWorthReplacing(originalBytes: number, compressedBytes: number, minSavingRatio: number): boolean {
  if (originalBytes <= 0 || compressedBytes >= originalBytes) return false;
  return (originalBytes - compressedBytes) / originalBytes >= minSavingRatio;
}

function isPng(bytes: Uint8Array): boolean {
  return bytes.length >= 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47 && bytes[4] === 0x0d && bytes[5] === 0x0a && bytes[6] === 0x1a && bytes[7] === 0x0a;
}

function isJpeg(bytes: Uint8Array): boolean {
  return bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
}

function isWebp(bytes: Uint8Array): boolean {
  return bytes.length >= 12 &&
    bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46 &&
    bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50;
}
