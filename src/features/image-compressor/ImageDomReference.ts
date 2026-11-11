/**
 * @design Lightweight `<img>` attribute scanning over block DOM. The authoritative rewriter is
 * `ImageReferenceParser`; this module stays side-effect free and is exercised by regression tests.
 */
export interface ImageTagReference {
  start: number;
  end: number;
  tag: string;
  url: string;
  occurrenceIndex: number;
}

/** Source-preserving scanner for image tags returned by getBlockDOM. */
export function imageReferences(html: string): ImageTagReference[] {
  const result: ImageTagReference[] = [];
  const counts = new Map<string, number>();
  for (const match of html.matchAll(/<img\b(?:"[^"]*"|'[^']*'|[^'">])*?>/gi)) {
    const tag = match[0];
    const src = getAttribute(tag, "data-src") || getAttribute(tag, "src");
    if (!src) continue;
    const occurrenceIndex = counts.get(src) ?? 0;
    counts.set(src, occurrenceIndex + 1);
    result.push({ start: match.index!, end: match.index! + tag.length, tag, url: src, occurrenceIndex });
  }
  return result;
}

export function matchingImageTags(html: string, source: string): Array<{ start: number; end: number; tag: string }> {
  return imageReferences(html).filter(ref => ref.url === source).map(({ start, end, tag }) => ({ start, end, tag }));
}

export function countMatchingImages(html: string, source: string): number {
  return imageReferences(html).filter(ref => ref.url === source).length;
}

export function matchingImageAt(html: string, source: string, occurrenceIndex: number): ImageTagReference | undefined {
  return imageReferences(html).filter(ref => ref.url === source)[occurrenceIndex];
}

/** Rewrites only the zero-based occurrence of a path within the exact block DOM. */
export function replaceImageAt(html: string, source: string, occurrenceIndex: number, next: string, expectedTag?: string): string | undefined {
  const ref = matchingImageAt(html, source, occurrenceIndex);
  if (!ref) return undefined;
  if (expectedTag !== undefined && ref.tag !== expectedTag) return undefined;
  if (countAttribute(ref.tag, "src") > 1 || countAttribute(ref.tag, "data-src") > 1) return undefined;
  let updated = setAttribute(ref.tag, "src", next);
  updated = setAttribute(updated, "data-src", next);
  return html.slice(0, ref.start) + updated + html.slice(ref.end);
}

/** Rewrites all occurrences only when the caller's observed count still matches. */
export function replaceMatchingImages(html: string, source: string, next: string, expectedCount = 1): string {
  const refs = imageReferences(html).filter(ref => ref.url === source);
  if (refs.length !== expectedCount) throw new Error("Image references changed or are ambiguous");
  let result = html;
  for (const ref of refs.reverse()) {
    if (countAttribute(ref.tag, "src") > 1 || countAttribute(ref.tag, "data-src") > 1) throw new Error("Image has duplicate source attributes");
    let updated = setAttribute(ref.tag, "src", next);
    updated = setAttribute(updated, "data-src", next);
    result = result.slice(0, ref.start) + updated + result.slice(ref.end);
  }
  return result;
}

/** Rewrites a whole block atomically in memory; any path count conflict rejects every edit. */
export function replaceBatchImages(html: string, replacements: Map<string, { next: string; expectedCount: number }>): string | undefined {
  for (const [source, value] of replacements) {
    if (countMatchingImages(html, source) !== value.expectedCount) return undefined;
  }
  let updated = html;
  for (const [source, value] of replacements) updated = replaceMatchingImages(updated, source, value.next, value.expectedCount);
  return updated;
}

export function countAttribute(tag: string, name: "src" | "data-src"): number {
  const pattern = new RegExp(`(?:^|\\s)${name}\\s*=`, "gi");
  return [...tag.matchAll(pattern)].length;
}

function getAttribute(tag: string, name: string): string | undefined {
  const match = tag.match(new RegExp(`(?:^|\\s)${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, "i"));
  const value = match?.[1] ?? match?.[2] ?? match?.[3];
  return value?.replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, "<");
}

function setAttribute(tag: string, name: string, value: string): string {
  const escaped = escapeAttribute(value);
  const pattern = new RegExp(`(\\s${name}\\s*=\\s*)(?:"[^"]*"|'[^']*'|[^\\s>]+)`, "i");
  if (pattern.test(tag)) return tag.replace(pattern, (_all, prefix: string) => `${prefix}"${escaped}"`);
  return tag.replace(/\s*\/?>$/, match => ` ${name}="${escaped}"${match}`);
}

function escapeAttribute(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");
}
