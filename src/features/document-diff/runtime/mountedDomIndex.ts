import { monotoneAnchors, type ScrollAnchor } from "../model/anchors.ts";
import { isValidBlockID, type DiffResult } from "../model/types.ts";
import type { VisibleDoc } from "./VisiblePair.ts";

export interface MountedBlockEntry {
  id: string;
  el: HTMLElement;
  rootIndex?: number;
  hasChildBlock: boolean;
}

export interface MountedDomIndex {
  byId: Map<string, HTMLElement>;
  ordered: MountedBlockEntry[];
  minRootIndex: number;
  maxRootIndex: number;
  topBoundaryLoaded: boolean;
  bottomBoundaryLoaded: boolean;
  trailingFoldedHeading?: HTMLElement;
}

export function isBlockRectVisible(rect: DOMRect): boolean {
  return rect.width > 0 || rect.height > 0;
}

export function getScroller(doc: VisibleDoc): HTMLElement {
  return (doc.protyle.contentElement ?? doc.protyle.wysiwyg.element.parentElement ?? doc.protyle.element) as HTMLElement;
}

/**
 * Single-pass scan over currently mounted `[data-node-id]` blocks inside `doc.protyle.wysiwyg.element`,
 * recording top-level root block ordinal bounds and virtualized scroll boundary flags.
 */
export function inspectMountedProtyleDom(
  doc: VisibleDoc,
  rootIndexMap: ReadonlyMap<string, number>,
  totalRootBlocks: number,
): MountedDomIndex {
  const wysiwygEl = doc.protyle.wysiwyg.element as HTMLElement;
  const byId = new Map<string, HTMLElement>();
  const ordered: MountedBlockEntry[] = [];
  let minRootIndex = Number.POSITIVE_INFINITY;
  let maxRootIndex = 0;

  const nodes = typeof wysiwygEl.querySelectorAll === "function"
    ? wysiwygEl.querySelectorAll<HTMLElement>("[data-node-id]")
    : [];
  const entryByEl = new Map<HTMLElement, MountedBlockEntry>();
  for (let i = 0; i < nodes.length; i++) {
    const el = nodes[i]!;
    if (el.closest?.(".protyle-wysiwyg__embed")) continue;
    const id = el.getAttribute("data-node-id");
    if (!isValidBlockID(id) || byId.has(id)) continue;
    byId.set(id, el);

    let parentCur = el.parentElement as HTMLElement | null;
    while (parentCur && parentCur !== wysiwygEl) {
      const parentEntry = entryByEl.get(parentCur);
      if (parentEntry) {
        parentEntry.hasChildBlock = true;
        break;
      }
      parentCur = parentCur.parentElement as HTMLElement | null;
    }

    const rootIndex = rootIndexMap.get(id);
    if (rootIndex !== undefined) {
      if (rootIndex < minRootIndex) minRootIndex = rootIndex;
      if (rootIndex > maxRootIndex) maxRootIndex = rootIndex;
    }
    const entry: MountedBlockEntry = { id, el, rootIndex, hasChildBlock: false };
    entryByEl.set(el, entry);
    ordered.push(entry);
  }

  if (!Number.isFinite(minRootIndex)) minRootIndex = 0;

  const children = wysiwygEl.children;
  const firstChild = children && children.length > 0 ? (children[0] as HTMLElement) : undefined;
  const lastChild = children && children.length > 0 ? (children[children.length - 1] as HTMLElement) : undefined;
  const trailingFoldedHeading =
    lastChild?.getAttribute?.("data-type") === "NodeHeading" && lastChild?.getAttribute?.("fold") === "1"
      ? lastChild
      : undefined;
  const topBoundaryLoaded =
    !doc.protyle?.block?.scroll ||
    firstChild?.getAttribute?.("data-eof") === "1" ||
    firstChild?.getAttribute?.("data-node-index") === "0" ||
    (minRootIndex > 0 && minRootIndex <= 1);
  const bottomBoundaryLoaded =
    !doc.protyle?.block?.scroll ||
    Boolean(wysiwygEl.hasAttribute?.("data-bottom-eof")) ||
    lastChild?.getAttribute?.("data-eof") === "2" ||
    (totalRootBlocks > 0 && maxRootIndex >= totalRootBlocks);

  return {
    byId,
    ordered,
    minRootIndex,
    maxRootIndex,
    topBoundaryLoaded,
    bottomBoundaryLoaded,
    trailingFoldedHeading,
  };
}

export function buildMountedScrollAnchors(params: {
  leftDoc: VisibleDoc;
  rightDoc: VisibleDoc;
  leftMounted: MountedDomIndex;
  rightMounted: MountedDomIndex;
  diff: DiffResult;
}): ScrollAnchor[] {
  const { leftDoc, rightDoc, leftMounted, rightMounted, diff } = params;
  if (leftMounted.byId.size === 0 || rightMounted.byId.size === 0) return [];

  const leftScroller = getScroller(leftDoc);
  const rightScroller = getScroller(rightDoc);
  const leftBase = leftScroller.scrollTop - leftScroller.getBoundingClientRect().top;
  const rightBase = rightScroller.scrollTop - rightScroller.getBoundingClientRect().top;

  const seenPairs = new Set<string>();
  const raw: ScrollAnchor[] = [];
  const tryAddPair = (leftBlockID?: string, rightBlockID?: string): void => {
    if (!leftBlockID || !rightBlockID) return;
    const pairKey = `${leftBlockID}:${rightBlockID}`;
    if (seenPairs.has(pairKey)) return;
    seenPairs.add(pairKey);
    const leftEl = leftMounted.byId.get(leftBlockID);
    const rightEl = rightMounted.byId.get(rightBlockID);
    if (!leftEl || !rightEl) return;
    const leftRect = leftEl.getBoundingClientRect();
    const rightRect = rightEl.getBoundingClientRect();
    if (!isBlockRectVisible(leftRect) || !isBlockRectVisible(rightRect)) return;
    raw.push({ leftY: leftRect.top + leftBase, rightY: rightRect.top + rightBase });
  };

  for (const match of diff.matches) tryAddPair(match.leftBlockID, match.rightBlockID);
  for (const hunk of diff.hunks) {
    if (hunk.kind === "modified" || hunk.kind === "unresolved") {
      tryAddPair(hunk.left[0]?.blockID, hunk.right[0]?.blockID);
    }
  }
  return monotoneAnchors(raw);
}

export function findReadingBlock(
  mounted: MountedDomIndex,
  scrollerRect: DOMRect,
  readingOffset: number,
): { id: string; el: HTMLElement; rootIndex?: number; progress: number } | undefined {
  if (mounted.ordered.length === 0) return undefined;
  const readingViewportY = scrollerRect.top + readingOffset;
  let spanningEntry: MountedBlockEntry | undefined;
  let spanningRect: DOMRect | undefined;
  let nearestLeafEntry: MountedBlockEntry | undefined;
  let nearestLeafRect: DOMRect | undefined;
  let nearestLeafDist = Number.POSITIVE_INFINITY;
  let fallbackAnyEntry: MountedBlockEntry | undefined;
  let fallbackAnyRect: DOMRect | undefined;
  let fallbackAnyDist = Number.POSITIVE_INFINITY;

  for (const entry of mounted.ordered) {
    const rect = entry.el.getBoundingClientRect();
    if (!isBlockRectVisible(rect)) continue;
    if (rect.top <= readingViewportY && readingViewportY <= rect.bottom) {
      spanningEntry = entry;
      spanningRect = rect;
      continue;
    }
    const dist = readingViewportY < rect.top ? rect.top - readingViewportY : readingViewportY - rect.bottom;
    if (!entry.hasChildBlock && dist < nearestLeafDist) {
      nearestLeafDist = dist;
      nearestLeafEntry = entry;
      nearestLeafRect = rect;
    }
    if (dist < fallbackAnyDist) {
      fallbackAnyDist = dist;
      fallbackAnyEntry = entry;
      fallbackAnyRect = rect;
    }
  }

  const bestEntry = spanningEntry ?? nearestLeafEntry ?? fallbackAnyEntry;
  const bestRect = spanningRect ?? nearestLeafRect ?? fallbackAnyRect;
  if (!bestEntry || !bestRect) return undefined;
  const progress = Math.max(0, Math.min(1, (readingViewportY - bestRect.top) / Math.max(1, bestRect.height)));
  return { id: bestEntry.id, el: bestEntry.el, rootIndex: bestEntry.rootIndex, progress };
}

export function resolveVisibleMountedOrAncestor(
  el: HTMLElement | undefined,
  boundary: HTMLElement,
): HTMLElement | undefined {
  let cur: HTMLElement | null | undefined = el;
  while (cur && cur !== boundary) {
    if (cur.getAttribute?.("data-node-id") && isBlockRectVisible(cur.getBoundingClientRect())) return cur;
    cur = cur.parentElement as HTMLElement | null;
  }
  return undefined;
}

export function findMountedTargetElement(
  mounted: MountedDomIndex,
  wysiwygEl: HTMLElement,
  targetBlockID: string | undefined,
  targetRootIndex: number,
): HTMLElement | undefined {
  if (targetBlockID) {
    const visible = resolveVisibleMountedOrAncestor(mounted.byId.get(targetBlockID), wysiwygEl);
    if (visible) return visible;
  }
  if (mounted.minRootIndex > 0 && targetRootIndex >= mounted.minRootIndex && targetRootIndex <= mounted.maxRootIndex) {
    let best: HTMLElement | undefined;
    let bestIdx = -1;
    for (const entry of mounted.ordered) {
      if (!isBlockRectVisible(entry.el.getBoundingClientRect())) continue;
      if (entry.rootIndex !== undefined && entry.rootIndex <= targetRootIndex && entry.rootIndex >= bestIdx) {
        bestIdx = entry.rootIndex;
        best = entry.el;
      }
    }
    if (best) return best;
  }
  if (
    mounted.bottomBoundaryLoaded &&
    mounted.trailingFoldedHeading &&
    targetRootIndex > mounted.maxRootIndex &&
    isBlockRectVisible(mounted.trailingFoldedHeading.getBoundingClientRect())
  ) {
    return mounted.trailingFoldedHeading;
  }
  return undefined;
}
