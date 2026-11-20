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
  const extension = encodedName.match(/\.([a-z0-9]+)$/i)?.[1]?.toLowerCase();
  if (!extension || !STATIC_FILE_EXTENSIONS.has(extension)) return null;

  try {
    const decoded = decodeURIComponent(encodedName).trim();
    return decoded || encodedName.trim() || null;
  } catch {
    return encodedName.trim() || null;
  }
}

export function isStaticFileUrl(url: string): boolean {
  return extractStaticFileName(url) !== null;
}
