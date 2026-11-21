const STATIC_FILE_EXTENSIONS = new Set([
  "zip", "rar", "7z", "tar", "gz", "exe", "dmg", "pkg", "apk", "deb", "rpm", "iso",
  "pdf", "docx", "xlsx", "pptx", "doc", "xls", "ppt", "epub", "mobi",
  "mp4", "mkv", "avi", "mov", "wmv", "flv", "mp3", "wav", "flac", "aac", "m4a",
  "png", "jpg", "jpeg", "webp", "svg", "gif", "bmp", "ico",
]);

export function extractStaticFileName(url: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }

  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
  const encodedName = parsed.pathname.split("/").at(-1) ?? "";
  let fileName: string;
  try {
    fileName = decodeURIComponent(encodedName);
  } catch {
    fileName = encodedName;
  }
  const trimmed = fileName.trim();
  const extension = trimmed.match(/\.([a-z0-9]+)$/i)?.[1]?.toLowerCase();
  if (!extension || !STATIC_FILE_EXTENSIONS.has(extension)) return null;
  return trimmed || null;
}

export function isStaticFileUrl(url: string): boolean {
  return extractStaticFileName(url) !== null;
}
