export type CompressionMode = "auto" | "manual-quick" | "manual-dialog" | "document";

export type ImageSkipReason =
  | "excalidraw"
  | "video"
  | "animated-format"
  | "vector-format"
  | "unsupported-format"
  | "excluded-extension";

export type ImageCandidateDecision =
  | { eligible: true; extension: string }
  | { eligible: false; reason: ImageSkipReason; extension: string };

export interface ImageCandidateInput {
  path: string;
  mode: CompressionMode;
  excludedExtensions: readonly string[];
  smartEnabled?: boolean;
}

export const DRAWING_DIRECTORY = /(?:^|[\\/])drawings?[\\/]/i;

const SUPPORTED_STATIC = new Set(["png", "jpg", "jpeg", "webp"]);

const VIDEO_EXTENSIONS = new Set([
  "mp4", "m4v", "mov", "avi", "wmv", "flv", "mkv", "webm", "3gp", "ogv",
  "mpeg", "mpg", "mts", "m2ts", "ts", "vob", "asf", "rm", "rmvb", "f4v",
]);

export function isProtectedDrawingPath(rawPath: string): boolean {
  return /excalidraw/i.test(rawPath) || DRAWING_DIRECTORY.test(rawPath);
}

export function isWebpAllowed(extension: string, mode: CompressionMode, smartEnabled = false): boolean {
  if (extension !== "webp") return false;
  return mode === "manual-dialog" || mode === "manual-quick" || smartEnabled === true;
}

export function extractImageExtension(rawPath: string): string {
  const clean = rawPath.replaceAll("\\", "/").split(/[?#]/, 1)[0];
  const basename = clean.slice(clean.lastIndexOf("/") + 1);
  const match = /\.([a-z0-9]{1,10})$/i.exec(basename);
  return match?.[1].toLowerCase() ?? "";
}

function normalizedPath(raw: string): string {
  let path = raw;
  try {
    if (/^[a-z][a-z0-9+.-]*:\/\//i.test(raw)) {
      path = new URL(raw).pathname;
    }
  } catch {
    path = raw;
  }
  return path.replaceAll("\\", "/").split(/[?#]/, 1)[0].toLowerCase();
}

/**
 * Pure classifier evaluating image candidates before disk read or download.
 * Excludes videos, excalidraw/drawings directories, vector formats (SVG), animated formats (GIF, APNG),
 * unsupported non-empty static extensions (preserving extensionless CDN URLs),
 * and user-excluded extensions (allowing static WebP in manual modes, or in auto/document modes when smartEnabled is true).
 */
export function classifyImageCandidate(input: ImageCandidateInput): ImageCandidateDecision {
  const path = normalizedPath(input.path);
  const extension = extractImageExtension(path);

  if (isProtectedDrawingPath(path)) {
    return { eligible: false, reason: "excalidraw", extension };
  }
  if (VIDEO_EXTENSIONS.has(extension)) {
    return { eligible: false, reason: "video", extension };
  }
  if (extension === "gif" || extension === "apng") {
    return { eligible: false, reason: "animated-format", extension };
  }
  if (extension === "svg") {
    return { eligible: false, reason: "vector-format", extension };
  }
  // 此处仅做基于路径扩展名的前置过滤：无扩展名的远程图床链接（extension === ""）予以放行，
  // 真实格式与动图/矢量图拦截延后至下载后的魔数检测（assertImagePayload / inspectImage）处理。
  if (extension !== "" && !SUPPORTED_STATIC.has(extension)) {
    return { eligible: false, reason: "unsupported-format", extension };
  }
  if (
    input.excludedExtensions.includes(extension) &&
    !isWebpAllowed(extension, input.mode, input.smartEnabled)
  ) {
    return { eligible: false, reason: "excluded-extension", extension };
  }
  return { eligible: true, extension };
}
