import { isInsideProtectedContainer } from "../../../core/host/dom.ts";

const INLINE_BOUNDARY_SPAN_TYPES = new Set([
  "inline-memo",
  "text",
  "block-ref",
  "file-annotation-ref",
  "a",
]);

export function isAutomaticLinkCandidate(text: string, href: string): boolean {
  if (text === "" || text === href) return true;
  if (!href.includes("%")) return false;
  try {
    if (decodeURI(href) === text) return true;
  } catch {}
  try {
    if (decodeURIComponent(href) === text) return true;
  } catch {}
  return false;
}

export function isHttpUrl(value: string): boolean {
  try {
    return /^(https?:)$/.test(new URL(value).protocol);
  } catch {
    return false;
  }
}

export function isSingleBareURL(textPlain: string): boolean {
  const trimmed = textPlain.trim();
  if (!trimmed || /\s/.test(trimmed)) return false;
  return isHttpUrl(trimmed);
}

export function hasClipboardLinkCandidate(textPlain: string, textHtml: string): boolean {
  return /https?:\/\//i.test(textPlain) || /https?:\/\//i.test(textHtml) || /<a\b/i.test(textHtml);
}

/**
 * Pure mirror of SiYuan `beforePaste` inline `SPAN` boundary escape without touching live `Selection`.
 * When a collapsed caret sits at the start or end text boundary of an inline `SPAN[data-type]`,
 * aligns the cloned range immediately before or after the `SPAN` so `trackRange` anchors wrap the pasted nodes.
 */
export function alignCollapsedPasteBoundary(original: Range): Range {
  const aligned = original.cloneRange();
  if (!aligned.collapsed) return aligned;

  const startNode = aligned.startContainer;
  const candidate =
    startNode?.nodeType === 1
      ? (startNode as HTMLElement)
      : (startNode?.parentElement as HTMLElement | null);
  if (!candidate || candidate.tagName?.toUpperCase() !== "SPAN" || !candidate.parentNode) {
    return aligned;
  }

  const types = (candidate.getAttribute("data-type") ?? "").split(/\s+/).filter(Boolean);
  if (!types.some(t => INLINE_BOUNDARY_SPAN_TYPES.has(t))) {
    return aligned;
  }

  const totalLength = (candidate.textContent ?? "").length;
  const children = candidate.childNodes ?? [];
  let charOffset = 0;

  if (startNode === candidate) {
    for (let i = 0; i < aligned.startOffset && i < children.length; i++) {
      charOffset += (children[i]?.textContent ?? "").length;
    }
  } else {
    for (let i = 0; i < children.length; i++) {
      const child = children[i];
      if (child === startNode) break;
      charOffset += (child?.textContent ?? "").length;
    }
    if (startNode.nodeType === 3 || startNode.nodeType === 4) {
      charOffset += aligned.startOffset;
    }
  }

  if (charOffset === 0) {
    aligned.setStartBefore(candidate);
    aligned.collapse(true);
  } else if (charOffset === totalLength) {
    aligned.setEndAfter(candidate);
    aligned.collapse(false);
  }
  return aligned;
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

export interface LinkSignature {
  href: string;
  text: string;
  title: string | null;
}

export interface PrePasteBlockAnchor {
  sourceBlockID: string;
  prefixLinks: LinkSignature[];
  suffixLinks: LinkSignature[];
  prePasteBlockIDs: Set<string>;
}

function readLinkSignature(link: HTMLElement): LinkSignature {
  return {
    href: link.getAttribute("data-href") ?? "",
    text: link.textContent ?? "",
    title: link.getAttribute("data-title"),
  };
}

function matchesLinkSignature(link: HTMLElement, sig: LinkSignature): boolean {
  return (
    (link.getAttribute("data-href") ?? "") === sig.href &&
    (link.textContent ?? "") === sig.text &&
    link.getAttribute("data-title") === sig.title
  );
}

function collectDirectBlockLinks(block: HTMLElement): HTMLElement[] {
  if (typeof block.querySelectorAll !== "function") return [];
  return [...block.querySelectorAll<HTMLElement>('span[data-type~="a"]')].filter(
    link => typeof link.closest !== "function" || link.closest("[data-node-id]") === block,
  );
}

function collectAllBlocksInEditor(editor: Element): HTMLElement[] {
  const out: HTMLElement[] = [];
  if (typeof (editor as HTMLElement).getAttribute === "function" && (editor as HTMLElement).getAttribute("data-node-id")) {
    out.push(editor as HTMLElement);
  }
  if (typeof editor.querySelectorAll === "function") {
    out.push(...editor.querySelectorAll<HTMLElement>("[data-node-id]"));
  }
  return out;
}

/**
 * Snapshot the source block's prefix/suffix link signatures around `boundary` and existing block IDs
 * so consecutive inline `SPAN` pastes remain uniquely provable even when SiYuan's collapsed `trackRange`
 * invalidates overlapping `close:span` boundaries after `SpinBlockDOM`.
 */
export function capturePrePasteBlockAnchor(editor: Element, boundary: Range): PrePasteBlockAnchor | null {
  const startEl = boundary.startContainer?.nodeType === 1
    ? (boundary.startContainer as Element)
    : boundary.startContainer?.parentElement;
  const endEl = boundary.endContainer?.nodeType === 1
    ? (boundary.endContainer as Element)
    : boundary.endContainer?.parentElement;
  const startBlock = startEl?.closest?.<HTMLElement>("[data-node-id]");
  const endBlock = endEl?.closest?.<HTMLElement>("[data-node-id]");
  const sourceBlockID = startBlock?.getAttribute("data-node-id") ?? "";
  if (!startBlock || !endBlock || !sourceBlockID) return null;

  const doc = editor.ownerDocument ?? (typeof document !== "undefined" ? document : undefined);
  if (!doc || typeof doc.createRange !== "function") return null;

  const startPoint = boundary.cloneRange();
  startPoint.collapse(true);
  const endPoint = boundary.cloneRange();
  endPoint.collapse(false);
  const startToStart = typeof Range !== "undefined" ? Range.START_TO_START : 0;
  const endToEnd = typeof Range !== "undefined" ? Range.END_TO_END : 2;

  const prefixLinks: LinkSignature[] = [];
  for (const link of collectDirectBlockLinks(startBlock)) {
    try {
      const linkRange = doc.createRange();
      linkRange.selectNode(link);
      if (linkRange.compareBoundaryPoints(endToEnd, startPoint) <= 0) {
        prefixLinks.push(readLinkSignature(link));
      }
    } catch {
      return null;
    }
  }

  const suffixLinks: LinkSignature[] = [];
  for (const link of collectDirectBlockLinks(endBlock)) {
    try {
      const linkRange = doc.createRange();
      linkRange.selectNode(link);
      if (linkRange.compareBoundaryPoints(startToStart, endPoint) >= 0) {
        suffixLinks.push(readLinkSignature(link));
      }
    } catch {
      return null;
    }
  }

  const prePasteBlockIDs = new Set<string>();
  for (const blk of collectAllBlocksInEditor(editor)) {
    const id = blk.getAttribute("data-node-id");
    if (id) prePasteBlockIDs.add(id);
  }
  return { sourceBlockID, prefixLinks, suffixLinks, prePasteBlockIDs };
}

/**
 * Fallback structural resolver used only when SiYuan's collapsed `trackRange` returns `"invalid"`.
 * Returns `null` if the source block or prefix/suffix link anchors cannot be uniquely verified.
 */
export function collectCandidateLinksFromBlockAnchor(
  editor: Element,
  anchor: PrePasteBlockAnchor | null,
  beforeElements: WeakSet<HTMLElement>,
): HTMLElement[] | null {
  if (!anchor) return null;
  const allBlocks = collectAllBlocksInEditor(editor);
  const sourceIdx = allBlocks.findIndex(blk => blk.getAttribute("data-node-id") === anchor.sourceBlockID);
  if (sourceIdx < 0) return null;

  const liveSourceBlock = allBlocks[sourceIdx]!;
  const scopeBlocks: HTMLElement[] = [liveSourceBlock];
  for (let i = sourceIdx + 1; i < allBlocks.length; i++) {
    const blk = allBlocks[i]!;
    const id = blk.getAttribute("data-node-id") ?? "";
    if (!id) continue;
    if (anchor.prePasteBlockIDs.has(id)) {
      if (typeof liveSourceBlock.contains === "function" && liveSourceBlock.contains(blk)) {
        continue;
      }
      break;
    }
    scopeBlocks.push(blk);
  }

  const allLinks = scopeBlocks.flatMap(collectDirectBlockLinks);
  const prefixCount = anchor.prefixLinks.length;
  const suffixCount = anchor.suffixLinks.length;
  if (allLinks.length < prefixCount + suffixCount) return null;

  for (let i = 0; i < prefixCount; i++) {
    if (!matchesLinkSignature(allLinks[i]!, anchor.prefixLinks[i]!)) return null;
  }
  for (let i = 0; i < suffixCount; i++) {
    if (!matchesLinkSignature(allLinks[allLinks.length - suffixCount + i]!, anchor.suffixLinks[i]!)) return null;
  }

  const inserted = allLinks.slice(prefixCount, allLinks.length - suffixCount);
  const result: HTMLElement[] = [];
  for (const link of inserted) {
    if (beforeElements.has(link)) continue;
    const href = link.getAttribute("data-href") ?? "";
    if (!isHttpUrl(href)) continue;
    if (isInsideProtectedContainer(link)) continue;
    if (!isAutomaticLinkCandidate(link.textContent ?? "", href)) continue;
    result.push(link);
  }
  return result;
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
