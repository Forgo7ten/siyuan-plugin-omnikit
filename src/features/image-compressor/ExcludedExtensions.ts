/** Parse a comma-separated extension list. Empty entries are intentionally ignored. */
export function parseExcludedExtensions(input: string): { ok: true; value: string } | { ok: false; token: string } {
  const extensions = new Set<string>();
  for (const part of input.split(",")) {
    const trimmed = part.trim();
    if (!trimmed) continue;
    const token = trimmed.startsWith(".") ? trimmed.slice(1) : trimmed;
    if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/.test(token)) return { ok: false, token: trimmed };
    extensions.add(token.toLowerCase());
  }
  return { ok: true, value: [...extensions].join(",") };
}

export function hasExcludedExtension(name: string, excludedExtensions: string): boolean {
  const parsed = parseExcludedExtensions(excludedExtensions);
  if (!parsed.ok || !parsed.value) return false;
  const path = name.split(/[?#]/, 1)[0].replace(/\\/g, "/");
  const filename = path.slice(path.lastIndexOf("/") + 1);
  const dot = filename.lastIndexOf(".");
  if (dot <= 0 || dot === filename.length - 1) return false;
  return new Set(parsed.value.split(",")).has(filename.slice(dot + 1).toLowerCase());
}

export function readExcludedExtensions(compression: Record<string, unknown>): string {
  const current = compression.excludedExtensions;
  let value = current;
  if (value === undefined && ["skipWebP", "skipGIF", "skipSVG", "skipExcalidraw"].some(field => field in compression)) {
    value = [
      compression.skipGIF !== false ? "gif" : "",
      compression.skipSVG !== false ? "svg" : "",
      compression.skipWebP !== false ? "webp" : "",
    ].filter(Boolean).join(",");
  }
  if (typeof value !== "string") throw new Error("Invalid excluded extensions");
  const parsed = parseExcludedExtensions(value);
  if (!parsed.ok) throw new Error(`Invalid excluded extension: ${parsed.token}`);
  return parsed.value;
}
