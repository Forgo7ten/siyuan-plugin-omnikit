export type CompressionMode = "auto" | "manual-quick" | "manual-dialog" | "document";

export type ImageSkipReason =
  | "excalidraw"
  | "video"
  | "animated-format"
  | "vector-format"
  | "excluded-extension";

export type ImageCandidateDecision =
  | { eligible: true; extension: string }
  | { eligible: false; reason: ImageSkipReason; extension: string };

export interface ImageCandidateInput {
  path: string;
  mode: CompressionMode;
  excludedExtensions: readonly string[];
}

const VIDEO_EXTENSIONS = new Set([
  "mp4", "m4v", "mov", "avi", "wmv", "flv", "mkv", "webm", "3gp", "ogv",
  "mpeg", "mpg", "mts", "m2ts", "ts", "vob", "asf", "rm", "rmvb", "f4v",
]);

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

function extensionOf(path: string): string {
  const basename = path.slice(path.lastIndexOf("/") + 1);
  const match = /\.([a-z0-9]{1,10})$/.exec(basename);
  return match?.[1] ?? "";
}

/**
 * Pure classifier evaluating image candidates before disk read or download.
 * Excludes videos, excalidraw/drawings, vector formats (SVG), animated formats (GIF, APNG),
 * and user-excluded extensions (with an exception for WebP in manual-dialog mode).
 */
export function classifyImageCandidate(input: ImageCandidateInput): ImageCandidateDecision {
  const path = normalizedPath(input.path);
  const extension = extensionOf(path);

  if (/excalidraw/i.test(path) || /(?:^|\/)drawings?(?:[\/._-]|$)/i.test(path)) {
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
  if (
    input.excludedExtensions.includes(extension) &&
    !(extension === "webp" && input.mode === "manual-dialog")
  ) {
    return { eligible: false, reason: "excluded-extension", extension };
  }
  return { eligible: true, extension };
}
