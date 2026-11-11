export interface ParsedImageReference {
  blockID: string;
  url: string;
  alt: string;
  title?: string;
  occurrenceIndex: number;
  urlStart: number;
  urlEnd: number;
  /** Stable syntax context used to reject a stale replacement. */
  signature: string;
  kind: "markdown" | "html";
  attribute?: "src" | "data-src";
  observedCount: number;
}

export interface ImageRewriteResult {
  ok: boolean;
  markdown: string;
  reason?: "not-found" | "ambiguous" | "reference-changed";
}

export interface ImageReferenceParser {
  scan(markdown: string, blockID: string): ParsedImageReference[];
  replaceOne(markdown: string, target: ParsedImageReference, nextURL: string): ImageRewriteResult;
  replaceMany(markdown: string, blockID: string, replacements: Map<string, { nextURL: string; expectedCount: number }>): ImageRewriteResult;
}

/**
 * @design A deliberately conservative, source-preserving parser for Markdown/Kramdown and
 * inline HTML images. It never round-trips the whole block through a serializer.
 * @safety Every rewrite re-scans and rejects ambiguous or changed references instead of
 * guessing which occurrence the user clicked.
 */
export class ConservativeImageReferenceParser implements ImageReferenceParser {
  scan(markdown: string, blockID: string): ParsedImageReference[] {
    const raw: Omit<ParsedImageReference, "occurrenceIndex" | "observedCount">[] = [];
    const masked = maskCode(markdown);
    scanMarkdownImages(masked, blockID, raw);
    scanHtmlImages(masked, blockID, raw);
    raw.sort((a, b) => a.urlStart - b.urlStart);
    const totals = new Map<string, number>();
    for (const ref of raw) totals.set(ref.url, (totals.get(ref.url) ?? 0) + 1);
    const counts = new Map<string, number>();
    return raw.map(ref => {
      const occurrenceIndex = counts.get(ref.url) ?? 0;
      counts.set(ref.url, occurrenceIndex + 1);
      return { ...ref, occurrenceIndex, observedCount: totals.get(ref.url)! };
    });
  }

  replaceOne(markdown: string, target: ParsedImageReference, nextURL: string): ImageRewriteResult {
    if (!target.blockID || target.urlStart < 0 || target.urlEnd > markdown.length) return { ok: false, markdown, reason: "not-found" };
    const matches = this.scan(markdown, target.blockID).filter(ref => ref.url === target.url);
    if (matches.length === 0) return { ok: false, markdown, reason: "not-found" };
    if (matches.length !== target.observedCount) return { ok: false, markdown, reason: "reference-changed" };
    const selected = matches[target.occurrenceIndex];
    if (!selected) return { ok: false, markdown, reason: "not-found" };
    if (selected.signature !== target.signature) return { ok: false, markdown, reason: "reference-changed" };
    const span = replacementSpan(markdown, selected, nextURL);
    return { ok: true, markdown: markdown.slice(0, span.start) + span.replacement + markdown.slice(span.end) };
  }

  replaceMany(markdown: string, blockID: string, replacements: Map<string, { nextURL: string; expectedCount: number }>): ImageRewriteResult {
    const refs = this.scan(markdown, blockID);
    const spans: Array<{ start: number; end: number; replacement: string }> = [];
    for (const [url, value] of replacements) {
      const found = refs.filter(ref => ref.url === url);
      if (found.length !== value.expectedCount) return { ok: false, markdown, reason: "reference-changed" };
      for (const ref of found) spans.push(replacementSpan(markdown, ref, value.nextURL));
    }
    spans.sort((a, b) => b.start - a.start);
    let updated = markdown;
    for (const span of spans) updated = updated.slice(0, span.start) + span.replacement + updated.slice(span.end);
    return { ok: true, markdown: updated };
  }
}

export const imageReferenceParser: ImageReferenceParser = new ConservativeImageReferenceParser();

function scanMarkdownImages(text: string, blockID: string, output: Omit<ParsedImageReference, "occurrenceIndex" | "observedCount">[]): void {
  for (let i = 0; i < text.length - 2; i++) {
    if (text[i] !== "!" || text[i + 1] !== "[") continue;
    const closeAlt = findClosing(text, i + 1, "[", "]");
    if (closeAlt < 0 || text[closeAlt + 1] !== "(") continue;
    const open = closeAlt + 1;
    let cursor = open + 1;
    while (/\s/.test(text[cursor] ?? "")) cursor++;
    const angle = text[cursor] === "<";
    const urlStart = angle ? cursor + 1 : cursor;
    let urlEnd = urlStart;
    if (angle) {
      while (urlEnd < text.length && (text[urlEnd] !== ">" || isEscaped(text, urlEnd))) urlEnd++;
      if (urlEnd >= text.length) continue;
    } else {
      let depth = 0;
      while (urlEnd < text.length) {
        const ch = text[urlEnd];
        if (isEscaped(text, urlEnd)) { urlEnd++; continue; }
        if (ch === "(" ) { depth++; urlEnd++; continue; }
        if (ch === ")") { if (depth === 0) break; depth--; urlEnd++; continue; }
        if (/\s/.test(ch) && depth === 0) break;
        urlEnd++;
      }
    }
    const closeDest = angle ? urlEnd + 1 : urlEnd;
    const closeParen = findClosingParen(text, closeDest, open);
    if (closeParen < 0) continue;
    const rawUrl = text.slice(urlStart, urlEnd);
    const url = decodeMarkdownDestination(rawUrl);
    const alt = text.slice(i + 2, closeAlt);
    const afterURL = text.slice(closeDest, closeParen).trim();
    const titleMatch = afterURL.match(/^(?:"([\s\S]*)"|'([\s\S]*)'|\(([\s\S]*)\))$/);
    const title = titleMatch?.[1] ?? titleMatch?.[2] ?? titleMatch?.[3];
    const signature = text.slice(i, closeParen + 1);
    output.push({ blockID, url, alt, title, urlStart, urlEnd, signature, kind: "markdown" });
    i = closeParen;
  }
}

function scanHtmlImages(text: string, blockID: string, output: Omit<ParsedImageReference, "occurrenceIndex" | "observedCount">[]): void {
  const pattern = /<img\b(?:"[^"]*"|'[^']*'|[^'">])*?>/gi;
  for (const match of text.matchAll(pattern)) {
    const tag = match[0];
    const names = findHtmlAttribute(tag, "data-src") ? ["data-src"] as const : ["src"] as const;
    for (const name of names) {
      const attr = findHtmlAttribute(tag, name);
      if (!attr) continue;
      const start = match.index! + attr.start;
      output.push({ blockID, url: decodeHtml(attr.value), alt: decodeHtml(findHtmlAttribute(tag, "alt")?.value ?? ""), title: decodeHtml(findHtmlAttribute(tag, "title")?.value ?? "") || undefined, urlStart: start, urlEnd: start + attr.value.length, signature: tag, kind: "html", attribute: name });
    }
  }
}

function findHtmlAttribute(tag: string, name: string): { start: number; value: string } | undefined {
  const re = new RegExp(`\\b${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, "i");
  const match = re.exec(tag);
  if (!match) return undefined;
  const value = match[1] ?? match[2] ?? match[3] ?? "";
  const valueOffset = match[0].lastIndexOf(value);
  return { start: match.index + valueOffset, value };
}

function replacementSpan(source: string, ref: ParsedImageReference, nextURL: string): { start: number; end: number; replacement: string } {
  if (ref.kind === "markdown") return { start: ref.urlStart, end: ref.urlEnd, replacement: escapeDestination(nextURL, ref.kind) };
  const start = source.lastIndexOf("<img", ref.urlStart);
  if (start < 0 || source.slice(start, start + ref.signature.length) !== ref.signature) return { start: ref.urlStart, end: ref.urlEnd, replacement: escapeDestination(nextURL, ref.kind) };
  const end = start + ref.signature.length;
  const tag = source.slice(start, end);
  const attribute = ref.attribute ?? "src";
  const attrPattern = new RegExp(`(\\b${attribute}\\s*=\\s*)(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, "gi");
  const attrs = [...tag.matchAll(attrPattern)];
  const hasTarget = attrs.some(match => decodeHtml(match[2] ?? match[3] ?? match[4] ?? "") === ref.url);
  const updated = hasTarget ? tag.replace(attrPattern, (whole, prefix: string, double: string | undefined, single: string | undefined, unquoted: string | undefined) => {
    if (decodeHtml(double ?? single ?? unquoted ?? "") !== ref.url) return whole;
    const escaped = escapeDestination(nextURL, "html");
    if (double !== undefined) return `${prefix}"${escaped}"`;
    if (single !== undefined) return `${prefix}'${escaped}'`;
    return `${prefix}${escaped}`;
  }) : tag;
  return { start, end, replacement: updated };
}

function maskCode(source: string): string {
  const chars = source.split("");
  const maskRange = (start: number, end: number) => { for (let i = start; i < end; i++) if (chars[i] !== "\n" && chars[i] !== "\r") chars[i] = " "; };
  const fence = /^\s{0,3}(```+|~~~+).*$/gm;
  let fenceStart = -1; let fenceChar = ""; let fenceLen = 0; let line: RegExpExecArray | null;
  while ((line = fence.exec(source))) {
    const marker = line[1];
    if (fenceStart < 0) { fenceStart = line.index; fenceChar = marker[0]; fenceLen = marker.length; }
    else if (marker[0] === fenceChar && marker.length >= fenceLen) { maskRange(fenceStart, fence.lastIndex); fenceStart = -1; }
  }
  if (fenceStart >= 0) maskRange(fenceStart, source.length);
  const inlineCode = /(`+)(?!`)[^\n]*?\1/g;
  while ((line = inlineCode.exec(source))) maskRange(line.index, line.index + line[0].length);
  return chars.join("");
}

function findClosing(text: string, start: number, left: string, right: string): number {
  let depth = 0;
  for (let i = start; i < text.length; i++) {
    if (isEscaped(text, i)) continue;
    if (text[i] === left) depth++;
    else if (text[i] === right && --depth === 0) return i;
  }
  return -1;
}
function findClosingParen(text: string, start: number, open: number): number {
  let depth = 1;
  for (let i = start; i < text.length; i++) {
    if (isEscaped(text, i)) continue;
    if (text[i] === "(") depth++;
    else if (text[i] === ")" && --depth === 0) return i;
  }
  return -1;
}
function isEscaped(text: string, index: number): boolean { let slashes = 0; for (let i = index - 1; i >= 0 && text[i] === "\\"; i--) slashes++; return slashes % 2 === 1; }
function decodeMarkdownDestination(value: string): string { return value.replace(/\\([\\()\s<>])/g, "$1"); }
function decodeHtml(value: string): string { return value.replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">"); }
function escapeDestination(value: string, kind: "markdown" | "html"): string { return kind === "html" ? value.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;") : value.replace(/([\\() ])/g, "\\$1"); }
