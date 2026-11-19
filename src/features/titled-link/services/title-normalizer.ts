export type TitleSource = "title" | "og:title" | "twitter:title" | "hostname";

export interface NormalizedTitle {
  readonly title: string;
  readonly source: TitleSource;
}

export interface NormalizeTitleOptions {
  readonly maxTitleLength: number;
  readonly fallbackToHostname: boolean;
  readonly unescapeHtml?: (value: string) => string;
}

const CHALLENGE_TITLE_PATTERN = /^just\s+a\s+moment(?:\.{3}|…)?$/i;

export function extractNormalizedTitle(
  html: string,
  url: string,
  options: NormalizeTitleOptions,
): NormalizedTitle | null {
  const pageTitle = extractPageTitle(html);
  if (pageTitle && CHALLENGE_TITLE_PATTERN.test(cleanWhitespace(pageTitle))) {
    return hostnameFallback(url, options);
  }

  const candidates: Array<[TitleSource, string | null]> = [
    ["title", pageTitle],
    ["og:title", extractMetaContent(html, "property", "og:title")],
    ["twitter:title", extractMetaContent(html, "name", "twitter:title")],
  ];
  const unescapeHtml = options.unescapeHtml ?? resolveLuteUnescape();
  for (const [source, raw] of candidates) {
    if (!raw) continue;
    const normalized = truncateGraphemes(cleanWhitespace(unescapeHtml(raw)), options.maxTitleLength);
    if (normalized) return { title: normalized, source };
  }
  return hostnameFallback(url, options);
}

export function truncateGraphemes(value: string, maxLength: number): string {
  if (!Number.isInteger(maxLength) || maxLength <= 0) return value;
  const graphemes = Array.from(new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(value), part => part.segment);
  if (graphemes.length <= maxLength) return value;
  if (maxLength <= 3) return ".".repeat(maxLength);
  return `${graphemes.slice(0, maxLength - 3).join("")}...`;
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
  const tags = html.match(/<meta\b[^>]*>/gi) ?? [];
  for (const tag of tags) {
    if (attribute(tag, key)?.toLowerCase() !== expected) continue;
    return attribute(tag, "content");
  }
  return null;
}

function attribute(tag: string, name: string): string | null {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const quoted = tag.match(new RegExp(`\\b${escaped}\\s*=\\s*(["'])([\\s\\S]*?)\\1`, "i"));
  if (quoted) return quoted[2] ?? null;
  return tag.match(new RegExp(`\\b${escaped}\\s*=\\s*([^\\s>]+)`, "i"))?.[1] ?? null;
}

function cleanWhitespace(value: string): string {
  return value.replace(/\s+/gu, " ").trim();
}

function hostnameFallback(url: string, options: NormalizeTitleOptions): NormalizedTitle | null {
  if (!options.fallbackToHostname) return null;
  try {
    return { title: new URL(url).hostname, source: "hostname" };
  } catch {
    return null;
  }
}

function resolveLuteUnescape(): (value: string) => string {
  const lute = (globalThis as typeof globalThis & {
    Lute?: { UnEscapeHTMLStr?: (value: string) => string };
  }).Lute;
  if (typeof lute?.UnEscapeHTMLStr === "function") {
    return lute.UnEscapeHTMLStr.bind(lute);
  }
  return (value: string) => value
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'");
}
