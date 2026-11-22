import { isInsideProtectedContainer } from "../../../core/host/dom.ts";

export function isAutomaticLinkCandidate(text: string, href: string): boolean {
  return text === "" || text === href;
}

export function isHttpUrl(value: string): boolean {
  try { return /^(https?:)$/.test(new URL(value).protocol); }
  catch { return false; }
}

export function isSingleBareURL(textPlain: string): boolean {
  const trimmed = textPlain.trim();
  if (!trimmed || /\s/.test(trimmed)) return false;
  return isHttpUrl(trimmed);
}

export function hasClipboardLinkCandidate(textPlain: string, textHtml: string): boolean {
  return /https?:\/\//i.test(textPlain) || /https?:\/\//i.test(textHtml) || /<a\b/i.test(textHtml);
}

function nodeOffsetLimit(node: Node): number {
  if (node.nodeType === 3 || node.nodeType === 4 || node.nodeType === 8) {
    return (node as CharacterData).length ?? node.textContent?.length ?? 0;
  }
  return node.childNodes?.length ?? 0;
}

function isValidEndpoint(editor: Node, container: Node | null | undefined, offset: number): container is Node {
  if (!container) return false;
  if (typeof (editor as { contains?: (n: Node) => boolean }).contains !== "function") return false;
  if (!editor.contains(container)) return false;
  return Number.isInteger(offset) && offset >= 0 && offset <= nodeOffsetLimit(container);
}

/**
 * Reconstruct a non-collapsed Range spanning from `start`'s start boundary to `end`'s end boundary
 * after verifying all endpoints lie inside `editor` within valid node bounds and `start <= end`.
 */
export function createRangeFromResolved(editor: Node, start: Range, end: Range): Range | null {
  if (
    !isValidEndpoint(editor, start.startContainer, start.startOffset) ||
    !isValidEndpoint(editor, start.endContainer, start.endOffset) ||
    !isValidEndpoint(editor, end.startContainer, end.startOffset) ||
    !isValidEndpoint(editor, end.endContainer, end.endOffset)
  ) {
    return null;
  }
  try {
    const startToEnd = typeof Range !== "undefined" ? Range.START_TO_END : 1;
    if (start.compareBoundaryPoints(startToEnd, end) > 0) {
      return null;
    }
    const doc = editor.ownerDocument ?? (typeof document !== "undefined" ? document : undefined);
    if (!doc || typeof doc.createRange !== "function") return null;
    const range = doc.createRange();
    range.setStart(start.startContainer, start.startOffset);
    range.setEnd(end.endContainer, end.endOffset);
    return range.collapsed ? null : range;
  } catch {
    return null;
  }
}

/** Check whether `node`'s full boundary lies inside `range` (`range.start <= node.start` and `range.end >= node.end`). */
export function isNodeFullyInsideRange(node: Node, range: Range): boolean {
  const doc = node.ownerDocument ?? (typeof document !== "undefined" ? document : undefined);
  if (!doc || typeof doc.createRange !== "function") return false;
  try {
    const nodeRange = doc.createRange();
    nodeRange.selectNode(node);
    const startToStart = typeof Range !== "undefined" ? Range.START_TO_START : 0;
    const endToEnd = typeof Range !== "undefined" ? Range.END_TO_END : 2;
    return (
      range.compareBoundaryPoints(startToStart, nodeRange) <= 0 &&
      range.compareBoundaryPoints(endToEnd, nodeRange) >= 0
    );
  } catch {
    return false;
  }
}

/** Snapshot pre-existing `span[data-type~="a"]` nodes only in the block(s) touched by `original`. */
export function collectPrePasteLinks(original: Range): WeakSet<HTMLElement> {
  const beforeElements = new WeakSet<HTMLElement>();
  const seenBlocks = new Set<HTMLElement>();
  const addFromNode = (node: Node | null | undefined) => {
    const element = node?.nodeType === 1 ? (node as Element) : node?.parentElement;
    const block = element?.closest?.<HTMLElement>("[data-node-id]");
    if (!block || seenBlocks.has(block) || typeof block.querySelectorAll !== "function") return;
    seenBlocks.add(block);
    for (const link of block.querySelectorAll<HTMLElement>('span[data-type~="a"]')) {
      beforeElements.add(link);
    }
  };
  addFromNode(original.startContainer);
  addFromNode(original.endContainer);
  return beforeElements;
}

/** Collect newly inserted HTTP(S) automatic link candidates strictly contained within `range`. */
export function collectCandidateLinksInRange(
  range: Range,
  beforeElements: WeakSet<HTMLElement>,
): HTMLElement[] {
  const container = range.commonAncestorContainer;
  const root = container?.nodeType === 1 ? (container as Element) : container?.parentElement;
  if (!root) return [];
  const candidates: HTMLElement[] = [];
  if (typeof (root as HTMLElement).matches === "function" && (root as HTMLElement).matches('span[data-type~="a"]')) {
    candidates.push(root as HTMLElement);
  }
  if (typeof root.querySelectorAll === "function") {
    candidates.push(...root.querySelectorAll<HTMLElement>('span[data-type~="a"]'));
  }
  const result: HTMLElement[] = [];
  for (const link of candidates) {
    if (beforeElements.has(link)) continue;
    if (!isNodeFullyInsideRange(link, range)) continue;
    const href = link.getAttribute("data-href") ?? "";
    if (!isHttpUrl(href)) continue;
    if (isInsideProtectedContainer(link)) continue;
    if (!isAutomaticLinkCandidate(link.textContent ?? "", href)) continue;
    result.push(link);
  }
  return result;
}
