export type TitleSource = "title" | "og:title" | "twitter:title" | "hostname";

export interface NormalizedTitle {
  readonly title: string;
  readonly source: TitleSource;
}

export type TitleExtractionResult =
  | { readonly ok: true; readonly title: string; readonly source: TitleSource }
  | { readonly ok: false; readonly reason: "challenge" | "missing-title" };

export interface NormalizeTitleOptions {
  readonly maxTitleLength: number;
  readonly fallbackToHostname: boolean;
  readonly unescapeHtml?: (value: string) => string;
}

const CHALLENGE_TITLE_PATTERN = /^just\s+a\s+moment(?:\.{3}|…)?$/i;
// Strip bidi overrides/isolates, zero-width space, and C0/C1 control chars while preserving ZWNJ (\u200C) and ZWJ (\u200D).
const DANGEROUS_CHARS = /[\u0000-\u001F\u007F-\u009F\u200B\u200E\u200F\u202A-\u202E\u2066-\u2069]/g;

export function extractNormalizedTitle(
  html: string,
  url: string,
  options: NormalizeTitleOptions,
): NormalizedTitle | null {
  const result = resolveNormalizedTitle(html, url, options);
  return result.ok ? { title: result.title, source: result.source } : null;
}

export function resolveNormalizedTitle(
  html: string,
  url: string,
  options: NormalizeTitleOptions,
): TitleExtractionResult {
  const candidates: Array<[TitleSource, string | null]> = [
    ["title", extractPageTitle(html)],
    ["og:title", extractMetaContent(html, "property", "og:title")],
    ["twitter:title", extractMetaContent(html, "name", "twitter:title")],
  ];
  const unescapeHtml = options.unescapeHtml ?? resolveLuteUnescape();
  for (const [source, raw] of candidates) {
    if (!raw) continue;
    const sanitized = sanitizeWhitespaceAndControls(unescapeHtml(raw));
    if (CHALLENGE_TITLE_PATTERN.test(sanitized)) {
      const fallback = hostnameFallback(url, options);
      return fallback
        ? { ok: true, ...fallback }
        : { ok: false, reason: "challenge" };
    }
    const normalized = truncateGraphemes(sanitized, options.maxTitleLength);
    if (normalized) return { ok: true, title: normalized, source };
  }
  const fallback = hostnameFallback(url, options);
  return fallback
    ? { ok: true, ...fallback }
    : { ok: false, reason: "missing-title" };
}

/** Shared final sanitization for all title sources: collapse whitespace first so \r\n\t stay word separators, then strip dangerous chars, then re-collapse and truncate. */
export function finalizeTitle(value: string, maxTitleLength: number): string {
  return truncateGraphemes(sanitizeWhitespaceAndControls(value), maxTitleLength);
}

export function truncateGraphemes(value: string, maxLength: number): string {
  if (!Number.isInteger(maxLength) || maxLength <= 0) return value;
  const graphemes = segmentGraphemes(value);
  if (graphemes.length <= maxLength) return value;
  if (maxLength <= 3) return graphemes.slice(0, maxLength).join("");
  return `${graphemes.slice(0, maxLength - 3).join("")}...`;
}

function segmentGraphemes(value: string): string[] {
  try {
    return Array.from(new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(value), part => part.segment);
  } catch {
    return Array.from(value);
  }
}

function extractTitleScope(html: string): string {
  const closedHead = html.match(/<head\b[^>]*>([\s\S]*?)<\/head\s*>/i);
  if (closedHead) return closedHead[1];

  const bodyIndex = html.search(/<body\b/i);
  const headOpen = /<head\b[^>]*>/i.exec(html);
  if (headOpen) {
    const start = headOpen.index + headOpen[0].length;
    return bodyIndex > start ? html.slice(start, bodyIndex) : html.slice(start);
  }

  const preBody = bodyIndex >= 0 ? html.slice(0, bodyIndex) : html;
  return preBody.replace(/<svg\b[^>]*>[\s\S]*?<\/svg\s*>/gi, "");
}

function extractPageTitle(html: string): string | null {
  const scope = extractTitleScope(html);
  return scope.match(/<title\b[^>]*>([\s\S]*?)<\/title\s*>/i)?.[1] ?? null;
}

function extractMetaContent(html: string, key: "name" | "property", expected: string): string | null {
  const scope = extractTitleScope(html);
  const tags = scope.match(/<meta\b(?:[^>"']|"[^"]*"|'[^']*')*>/gi) ?? [];
  for (const tag of tags) {
    if (attribute(tag, key)?.toLowerCase() !== expected) continue;
    return attribute(tag, "content");
  }
  return null;
}

function attribute(tag: string, name: string): string | null {
  const expected = name.toLowerCase();
  let index = tag.indexOf("<") + 1;
  while (index < tag.length && !isTagNameEnd(tag[index])) index += 1;
  while (index < tag.length) {
    while (index < tag.length && /[\s/]/.test(tag[index])) index += 1;
    if (index >= tag.length || tag[index] === ">") break;
    const nameStart = index;
    while (index < tag.length && !/[\s=/>]/.test(tag[index])) index += 1;
    const attributeName = tag.slice(nameStart, index).toLowerCase();
    while (index < tag.length && /\s/.test(tag[index])) index += 1;
    let value: string | null = null;
    if (tag[index] === "=") {
      index += 1;
      while (index < tag.length && /\s/.test(tag[index])) index += 1;
      const quote = tag[index];
      if (quote === '"' || quote === "'") {
        const end = tag.indexOf(quote, index + 1);
        value = tag.slice(index + 1, end < 0 ? tag.length : end);
        index = end < 0 ? tag.length : end + 1;
      } else {
        const valueStart = index;
        while (index < tag.length && !/[\s>]/.test(tag[index])) index += 1;
        value = tag.slice(valueStart, index);
      }
    }
    if (attributeName === expected) return value;
  }
  return null;
}

function isTagNameEnd(char: string | undefined): boolean {
  return char === undefined || char === " " || char === "\t" || char === "\n" || char === "\r" || char === "/" || char === ">";
}

function sanitizeWhitespaceAndControls(value: string): string {
  return cleanWhitespace(cleanWhitespace(value).replace(DANGEROUS_CHARS, ""));
}

function cleanWhitespace(value: string): string {
  return value.replace(/\s+/gu, " ").trim();
}

function hostnameFallback(url: string, options: NormalizeTitleOptions): NormalizedTitle | null {
  if (!options.fallbackToHostname) return null;
  try {
    const title = finalizeTitle(new URL(url).hostname, options.maxTitleLength);
    return title ? { title, source: "hostname" } : null;
  } catch {
    return null;
  }
}

function safeCodePoint(code: number): string {
  if (!Number.isInteger(code) || code < 0 || code > 0x10ffff) return "";
  try { return String.fromCodePoint(code); } catch { return ""; }
}

const NAMED_ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
};

function resolveLuteUnescape(): (value: string) => string {
  const lute = (globalThis as typeof globalThis & {
    Lute?: { UnEscapeHTMLStr?: (value: string) => string };
  }).Lute;
  if (typeof lute?.UnEscapeHTMLStr === "function") {
    return lute.UnEscapeHTMLStr.bind(lute);
  }
  return (value: string) => value.replace(
    /&(?:#x([0-9a-f]+)|#(\d+)|(amp|lt|gt|quot|apos));/gi,
    (_, hex?: string, dec?: string, named?: string) => {
      if (hex !== undefined) return safeCodePoint(parseInt(hex, 16));
      if (dec !== undefined) return safeCodePoint(Number(dec));
      return NAMED_ENTITIES[named!.toLowerCase()] ?? "";
    },
  );
}
