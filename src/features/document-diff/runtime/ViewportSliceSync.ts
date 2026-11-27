import type { App } from "siyuan";
import type { HostBridge } from "../host/SiyuanBridge.ts";
import { computeAlignedScrollTop, monotoneAnchors, type ScrollAnchor } from "../model/anchors.ts";
import {
  classifyAdjacentDynamicMode,
  computeDisjointSliceStartIndex,
  mapBlockAcrossDiff,
  resolveHunkTargetForSide,
  type CrossDiffMappingContext,
} from "../model/blockMapping.ts";
import type { DiffHunk, Side } from "../model/types.ts";
import type { ScrollSync } from "./ScrollSync.ts";
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

interface PendingSliceAlignment {
  targetBlockID?: string;
  targetRootIndex: number;
  lastRequestedStartIndex?: number;
  sourceProgress: number;
  alignMode: "reading" | "center";
  fromSide: Side;
  expiresAt: number;
  attempts: number;
}

export interface ViewportSliceSyncHost extends CrossDiffMappingContext {
  readonly app: App;
  readonly bridge: HostBridge;
  readonly leftDoc: VisibleDoc;
  readonly rightDoc: VisibleDoc;
  readonly scrollSync: ScrollSync;
  readonly closed: boolean;
  readonly pending: boolean;
  withSwappingGuard<T>(fn: () => T): T;
  scheduleOverlayRedraw(rebindRanges: boolean): void;
  debugLog(stage: string, detail: Record<string, unknown>, throttleKey?: string, throttleMs?: number): void;
}

const VALID_BLOCK_ID_RE = /^\d{14}-[a-zA-Z0-9]{7}$/;
const SLICE_JUMP_DEBOUNCE_MS = 90;
const DEFAULT_DYNAMIC_LOAD_BLOCKS = 64;

function isBlockRectVisible(rect: DOMRect): boolean {
  return rect.width > 0 || rect.height > 0;
}

export function getScroller(doc: VisibleDoc): HTMLElement {
  return (doc.protyle.contentElement ?? doc.protyle.wysiwyg.element.parentElement ?? doc.protyle.element) as HTMLElement;
}

function getDynamicLoadWindowSize(doc: VisibleDoc): number {
  const fromGlobal = (globalThis as { siyuan?: { config?: { editor?: { dynamicLoadBlocks?: number } } } })
    .siyuan?.config?.editor?.dynamicLoadBlocks;
  if (typeof fromGlobal === "number" && Number.isFinite(fromGlobal) && fromGlobal > 0) return fromGlobal;
  const fromDoc = doc.protyle?.options?.size;
  return typeof fromDoc === "number" && Number.isFinite(fromDoc) && fromDoc > 0 ? fromDoc : DEFAULT_DYNAMIC_LOAD_BLOCKS;
}

function queryLiveBlock(doc: VisibleDoc, blockID?: string): HTMLElement | null {
  if (!blockID || !VALID_BLOCK_ID_RE.test(blockID)) return null;
  const nodes = (doc.protyle.wysiwyg.element as HTMLElement).querySelectorAll<HTMLElement>(`[data-node-id="${blockID}"]`);
  for (let i = 0; i < nodes.length; i++) {
    if (!nodes[i]!.closest(".protyle-wysiwyg__embed")) return nodes[i]!;
  }
  return null;
}

/**
 * Coordinates virtualized long-document DOM inspection, scroll anchor construction,
 * adjacent/disjoint slice loading, and cross-viewport hunk navigation alignment.
 */
export class ViewportSliceSync {
  private readonly sliceJumpTimers: Partial<Record<Side, ReturnType<typeof setTimeout>>> = {};
  private readonly sliceStabilizeTimers: Partial<Record<Side, ReturnType<typeof setTimeout>>> = {};
  private readonly pendingSliceSync: Partial<Record<Side, PendingSliceAlignment>> = {};
  private lastUserScrollSide?: Side;
  private lastUserScrollAt = 0;
  private lastStaticDriverSide?: Side;
  private lastStaticDriverAt = 0;

  constructor(private readonly host: ViewportSliceSyncHost) {}

  private docFor(side: Side): VisibleDoc {
    return side === "left" ? this.host.leftDoc : this.host.rightDoc;
  }

  private totalRootsFor(side: Side): number {
    return side === "left" ? this.host.leftRootBlockIDs.length : this.host.rightRootBlockIDs.length;
  }

  recordUserScrollIntent(side: Side, trigger: string, isStaticSliceTrigger = false): void {
    if (this.host.closed) return;
    const now = Date.now();
    this.lastUserScrollSide = side;
    this.lastUserScrollAt = now;
    if (isStaticSliceTrigger) {
      this.lastStaticDriverSide = side;
      this.lastStaticDriverAt = now;
    }
    this.host.scrollSync.notifyUserIntent(side);
    if (trigger !== "pointerdown" || isStaticSliceTrigger) this.cancelPendingForSide(side);
    this.host.debugLog("user-scroll-intent", { side, trigger, isStaticSliceTrigger }, `intent:${side}:${trigger}`, 300);
  }

  cancelPendingForSide(side: Side): void {
    delete this.pendingSliceSync[side];
    if (this.sliceJumpTimers[side] !== undefined) {
      clearTimeout(this.sliceJumpTimers[side]);
      delete this.sliceJumpTimers[side];
    }
    if (this.sliceStabilizeTimers[side] !== undefined) {
      clearTimeout(this.sliceStabilizeTimers[side]);
      delete this.sliceStabilizeTimers[side];
    }
  }

  clearTimers(): void {
    this.cancelPendingForSide("left");
    this.cancelPendingForSide("right");
  }

  inspectMountedDom(side: Side): MountedDomIndex {
    const doc = this.docFor(side);
    const rootIndexMap = side === "left" ? this.host.leftRootIndexByBlockID : this.host.rightRootIndexByBlockID;
    const totalRootBlocks = this.totalRootsFor(side);
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
      if (!id || !VALID_BLOCK_ID_RE.test(id) || byId.has(id)) continue;
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

    return { byId, ordered, minRootIndex, maxRootIndex, topBoundaryLoaded, bottomBoundaryLoaded, trailingFoldedHeading };
  }

  computeScrollAnchors(): ScrollAnchor[] {
    if (this.host.pending || (this.host.diff.matches.length === 0 && this.host.diff.hunks.length === 0)) return [];
    const leftMounted = this.inspectMountedDom("left");
    const rightMounted = this.inspectMountedDom("right");
    if (leftMounted.byId.size === 0 || rightMounted.byId.size === 0) return [];

    const leftScroller = getScroller(this.host.leftDoc);
    const rightScroller = getScroller(this.host.rightDoc);
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

    for (const match of this.host.diff.matches) tryAddPair(match.leftBlockID, match.rightBlockID);
    for (const hunk of this.host.diff.hunks) {
      if (hunk.kind === "modified" || hunk.kind === "unresolved") {
        tryAddPair(hunk.left[0]?.blockID, hunk.right[0]?.blockID);
      }
    }
    return monotoneAnchors(raw);
  }

  findReadingBlock(
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

  private resolveVisibleMountedOrAncestor(el: HTMLElement | undefined, boundary: HTMLElement): HTMLElement | undefined {
    let cur: HTMLElement | null | undefined = el;
    while (cur && cur !== boundary) {
      if (cur.getAttribute?.("data-node-id") && isBlockRectVisible(cur.getBoundingClientRect())) return cur;
      cur = cur.parentElement as HTMLElement | null;
    }
    return undefined;
  }

  private findMountedTargetElement(
    mounted: MountedDomIndex,
    wysiwygEl: HTMLElement,
    targetBlockID: string | undefined,
    targetRootIndex: number,
  ): HTMLElement | undefined {
    if (targetBlockID) {
      const visible = this.resolveVisibleMountedOrAncestor(mounted.byId.get(targetBlockID), wysiwygEl);
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
      mounted.trailingFoldedHeading &&
      targetRootIndex > mounted.maxRootIndex &&
      isBlockRectVisible(mounted.trailingFoldedHeading.getBoundingClientRect())
    ) {
      return mounted.trailingFoldedHeading;
    }
    return undefined;
  }

  handleUnmappedScroll(
    fromSide: Side,
    readingContentY: number,
    _own: unknown,
    _other: unknown,
    anchorCount: number,
  ): number | null {
    if (this.host.closed || this.host.pending) return null;
    const toSide: Side = fromSide === "left" ? "right" : "left";
    const ownDoc = this.docFor(fromSide);
    const otherDoc = this.docFor(toSide);
    const ownScroller = getScroller(ownDoc);
    const otherScroller = getScroller(otherDoc);
    const readingOffset = Math.min(48, Math.max(0, ownScroller.clientHeight * 0.15));

    const ownMounted = this.inspectMountedDom(fromSide);
    const otherMounted = this.inspectMountedDom(toSide);
    const readingBlock = this.findReadingBlock(ownMounted, ownScroller.getBoundingClientRect(), readingOffset);
    if (!readingBlock) return null;

    const mapped = mapBlockAcrossDiff(this.host, fromSide, readingBlock.id, readingBlock.rootIndex);
    if (!mapped) return null;

    const otherWysiwygEl = otherDoc.protyle.wysiwyg.element as HTMLElement;
    const mountedTargetEl = this.findMountedTargetElement(
      otherMounted,
      otherWysiwygEl,
      mapped.targetBlockID,
      mapped.targetRootIndex,
    );
    if (mountedTargetEl) {
      const otherScrollerRect = otherScroller.getBoundingClientRect();
      const targetRect = mountedTargetEl.getBoundingClientRect();
      const targetContentTop = targetRect.top - otherScrollerRect.top + otherScroller.scrollTop;
      const mappedY = targetContentTop + readingBlock.progress * Math.max(1, targetRect.height);
      this.host.debugLog(
        "scroll-unmapped-mounted-hit",
        {
          from: fromSide,
          to: toSide,
          readingContentY: Math.round(readingContentY),
          anchorCount,
          sourceBlockID: readingBlock.id,
          targetBlockID: mapped.targetBlockID ?? null,
          targetRootIndex: mapped.targetRootIndex,
          mappingKind: mapped.mappingKind,
          mappedY: Math.round(mappedY),
        },
        `unmapped-hit:${fromSide}`,
      );
      return mappedY;
    }

    const ownDesc = `${ownMounted.minRootIndex}..${ownMounted.maxRootIndex}/${this.totalRootsFor(fromSide)}`;
    const otherDesc = `${otherMounted.minRootIndex}..${otherMounted.maxRootIndex}/${this.totalRootsFor(toSide)}`;
    const prevPending = this.pendingSliceSync[toSide];
    const samePendingTarget =
      prevPending !== undefined &&
      Date.now() <= prevPending.expiresAt &&
      prevPending.targetRootIndex === mapped.targetRootIndex;
    this.pendingSliceSync[toSide] = {
      targetBlockID: mapped.targetBlockID,
      targetRootIndex: mapped.targetRootIndex,
      lastRequestedStartIndex: samePendingTarget ? prevPending.lastRequestedStartIndex : undefined,
      sourceProgress: readingBlock.progress,
      alignMode: "reading",
      fromSide,
      expiresAt: Date.now() + 3500,
      attempts: samePendingTarget ? prevPending.attempts : 0,
    };

    const adjacentMode = classifyAdjacentDynamicMode({
      targetRootIndex: mapped.targetRootIndex,
      minRootIndex: otherMounted.minRootIndex,
      maxRootIndex: otherMounted.maxRootIndex,
      topBoundaryLoaded: otherMounted.topBoundaryLoaded,
      bottomBoundaryLoaded: otherMounted.bottomBoundaryLoaded,
      windowSize: getDynamicLoadWindowSize(otherDoc),
    });

    if (adjacentMode !== null) {
      const edgeTop = adjacentMode === 1 ? 1 : Math.max(0, otherScroller.scrollHeight - otherScroller.clientHeight);
      this.host.scrollSync.applyProgrammaticScroll(toSide, edgeTop, fromSide);
      const dynamicAlreadyInFlight = Boolean(otherWysiwygEl.getAttribute?.("data-top"));
      const started = dynamicAlreadyInFlight ? false : this.triggerProtyleDynamicLoad(otherDoc, adjacentMode);
      this.host.debugLog(
        "scroll-cross-slice-dynamic",
        {
          from: fromSide,
          to: toSide,
          mode: adjacentMode,
          started,
          dynamicAlreadyInFlight,
          sourceBlockID: readingBlock.id,
          targetBlockID: mapped.targetBlockID ?? null,
          targetRootIndex: mapped.targetRootIndex,
          mappingKind: mapped.mappingKind,
          ownMounted: ownDesc,
          otherMounted: otherDesc,
        },
        `cross-dyn:${toSide}:${adjacentMode}`,
      );
      if (started || dynamicAlreadyInFlight) return null;
    }

    this.scheduleDisjointSliceJump(toSide, mapped.targetRootIndex, mapped.targetBlockID, ownDesc, otherDesc, mapped.mappingKind);
    return null;
  }

  prepareTargetProtyleScroll(
    targetSide: Side,
    targetScrollTop: number,
    previousScrollTop: number,
    _sourceSide: Side,
  ): number {
    const doc = this.docFor(targetSide);
    const scroller = getScroller(doc);
    const scrollObj = doc.protyle?.scroll;
    const mounted = this.inspectMountedDom(targetSide);
    let adjustedTop = targetScrollTop;

    if (adjustedTop < previousScrollTop && adjustedTop < 1 && !mounted.topBoundaryLoaded) adjustedTop = 1;

    if (scrollObj && typeof scrollObj.lastScrollTop === "number") {
      if (adjustedTop > previousScrollTop) {
        scrollObj.lastScrollTop = Math.max(0, Math.floor(adjustedTop - 16));
      } else if (adjustedTop < previousScrollTop) {
        scrollObj.lastScrollTop = Math.max(Math.ceil(adjustedTop + 16), Math.floor(previousScrollTop));
      } else if (scrollObj.lastScrollTop !== -1) {
        scrollObj.lastScrollTop = Math.max(0, Math.floor(adjustedTop));
      }
    }

    if (
      adjustedTop > previousScrollTop &&
      !mounted.bottomBoundaryLoaded &&
      scroller.clientHeight > 0 &&
      adjustedTop > scroller.scrollHeight - scroller.clientHeight * 1.8
    ) {
      this.triggerProtyleDynamicLoad(doc, 2);
    } else if (
      adjustedTop < previousScrollTop &&
      !mounted.topBoundaryLoaded &&
      scroller.clientHeight > 0 &&
      adjustedTop < scroller.clientHeight
    ) {
      this.triggerProtyleDynamicLoad(doc, 1);
    }
    return adjustedTop;
  }

  private triggerProtyleDynamicLoad(doc: VisibleDoc, mode: 1 | 2): boolean {
    const scrollObj = doc.protyle?.scroll;
    if (!scrollObj || typeof scrollObj.loadDynamic !== "function") return false;
    try {
      return Boolean(scrollObj.loadDynamic(doc.protyle, mode, { suppressFocus: true }));
    } catch {
      return false;
    }
  }

  scheduleDisjointSliceJump(
    targetSide: Side, targetRootIndex: number, targetBlockID: string | undefined,
    ownMountedDesc: string, otherMountedDesc: string, mappingKind: string,
  ): void {
    if (this.sliceJumpTimers[targetSide] !== undefined) clearTimeout(this.sliceJumpTimers[targetSide]);
    this.sliceJumpTimers[targetSide] = setTimeout(() => {
      delete this.sliceJumpTimers[targetSide];
      if (!this.host.closed) {
        this.executeDisjointSliceJump(targetSide, targetRootIndex, targetBlockID, ownMountedDesc, otherMountedDesc, mappingKind);
      }
    }, SLICE_JUMP_DEBOUNCE_MS);
  }

  executeDisjointSliceJump(
    targetSide: Side, targetRootIndex: number, targetBlockID: string | undefined,
    ownMountedDesc: string, otherMountedDesc: string, mappingKind: string,
  ): void {
    if (this.host.closed) return;
    const targetDoc = this.docFor(targetSide);
    const wysiwygEl = targetDoc.protyle?.wysiwyg?.element as HTMLElement | undefined;
    const mounted = this.inspectMountedDom(targetSide);
    if (wysiwygEl && this.findMountedTargetElement(mounted, wysiwygEl, targetBlockID, targetRootIndex)) {
      this.applyPendingSliceAlignment(targetSide, "already-mounted");
      return;
    }

    const totalRootBlocks = Math.max(
      this.totalRootsFor(targetSide),
      Number(targetDoc.protyle?.block?.blockCount) || 0,
      targetRootIndex,
    );
    const desiredStartIndex = computeDisjointSliceStartIndex({
      targetRootIndex, totalRootBlocks,
      windowSize: getDynamicLoadWindowSize(targetDoc),
      minRootIndex: mounted.minRootIndex, maxRootIndex: mounted.maxRootIndex,
    });

    const pending = this.pendingSliceSync[targetSide];
    if (pending && pending.lastRequestedStartIndex === desiredStartIndex && pending.attempts >= 1) return;
    if (pending) pending.lastRequestedStartIndex = desiredStartIndex;

    const scrollObj = targetDoc.protyle?.scroll;
    try { scrollObj?.invalidateDynamicLoad?.(targetDoc.protyle); } catch { /* ignore */ }

    if (wysiwygEl?.getAttribute?.("data-top")) {
      this.host.debugLog("scroll-disjoint-slice-queued-busy", {
        targetSide, targetRootIndex, desiredStartIndex, targetBlockID: targetBlockID ?? null,
      });
      return;
    }

    let triggeredVia: "setIndex" | "sliderEvent" | "openDocTab" | "none" = "none";
    const sliderInput =
      (scrollObj?.inputElement as HTMLInputElement | undefined) ??
      (scrollObj?.element?.querySelector?.("input.b3-slider") as HTMLInputElement | null | undefined) ??
      (targetDoc.protyle?.element?.querySelector?.(".protyle-scroll__bar input.b3-slider") as HTMLInputElement | null | undefined);

    try { scrollObj?.setCurrentIndex?.(targetDoc.protyle, desiredStartIndex, true); } catch { /* ignore */ }
    if (sliderInput) sliderInput.value = String(desiredStartIndex);

    if (typeof scrollObj?.setIndex === "function") {
      scrollObj.setIndex(targetDoc.protyle);
      triggeredVia = "setIndex";
    } else if (sliderInput && typeof sliderInput.dispatchEvent === "function" && typeof Event === "function") {
      sliderInput.dispatchEvent(new Event("change"));
      triggeredVia = "sliderEvent";
    } else if (targetBlockID && VALID_BLOCK_ID_RE.test(targetBlockID)) {
      void this.host.bridge.openDocTab({
        app: this.host.app, id: targetBlockID, action: ["cb-get-context"], keepCursor: false, removeCurrentTab: false,
      });
      triggeredVia = "openDocTab";
    }

    this.host.debugLog("scroll-disjoint-slice-jump", {
      targetSide, triggeredVia, targetBlockID: targetBlockID ?? null,
      targetRootIndex, desiredStartIndex, totalRootBlocks, mappingKind,
      ownMounted: ownMountedDesc, otherMounted: otherMountedDesc,
    });
  }

  handleProtyleSliceLoaded(side: Side, eventName: "loaded-protyle-static" | "loaded-protyle-dynamic"): void {
    const pending = this.pendingSliceSync[side];
    if (pending && Date.now() <= pending.expiresAt) {
      this.host.scrollSync.suppressEcho(side);
      this.applyPendingSliceAlignment(side, eventName);
      return;
    }
    delete this.pendingSliceSync[side];

    if (this.lastUserScrollSide && this.lastUserScrollSide !== side && Date.now() - this.lastUserScrollAt < 2500) {
      this.host.scrollSync.suppressEcho(side);
      return;
    }

    if (
      eventName === "loaded-protyle-static" &&
      this.host.scrollSync.isEnabled &&
      this.lastStaticDriverSide === side &&
      Date.now() - this.lastStaticDriverAt < 3000
    ) {
      const mounted = this.inspectMountedDom(side);
      this.host.debugLog("scroll-driver-static-load", {
        side,
        mountedRange: `${mounted.minRootIndex}..${mounted.maxRootIndex}/${this.totalRootsFor(side)}`,
      });
      this.host.scrollSync.handleScroll(side);
    }
  }

  applyPendingSliceAlignment(side: Side, trigger: string): void {
    const pending = this.pendingSliceSync[side];
    if (!pending || Date.now() > pending.expiresAt) {
      delete this.pendingSliceSync[side];
      return;
    }

    const doc = this.docFor(side);
    const wysiwygEl = doc.protyle.wysiwyg.element as HTMLElement;
    const scroller = getScroller(doc);
    const scrollerRect = scroller.getBoundingClientRect();
    const mounted = this.inspectMountedDom(side);
    const mountedRange = `${mounted.minRootIndex}..${mounted.maxRootIndex}/${this.totalRootsFor(side)}`;
    let targetEl = this.findMountedTargetElement(mounted, wysiwygEl, pending.targetBlockID, pending.targetRootIndex);

    if (
      !targetEl &&
      pending.lastRequestedStartIndex !== undefined &&
      mounted.maxRootIndex > 0 &&
      mounted.maxRootIndex < pending.lastRequestedStartIndex
    ) {
      for (let i = mounted.ordered.length - 1; i >= 0; i--) {
        const candidate = mounted.ordered[i]!.el;
        if (isBlockRectVisible(candidate.getBoundingClientRect())) {
          targetEl = candidate;
          break;
        }
      }
    }

    if (!targetEl) {
      if (pending.attempts < 2) {
        pending.attempts++;
        this.scheduleDisjointSliceJump(side, pending.targetRootIndex, pending.targetBlockID, "pending-retry", mountedRange, "retry-after-load");
      } else {
        this.host.debugLog("scroll-slice-align-missed", {
          side,
          trigger,
          targetBlockID: pending.targetBlockID ?? null,
          targetRootIndex: pending.targetRootIndex,
          mountedRange,
        });
        delete this.pendingSliceSync[side];
      }
      return;
    }

    if (pending.alignMode === "center") doc.protyle?.observerLoad?.disconnect?.();

    const alignToTarget = (): number => {
      const clamped = computeAlignedScrollTop(
        scroller.scrollTop, scroller.scrollHeight, scroller.clientHeight,
        scroller.getBoundingClientRect(), targetEl.getBoundingClientRect(),
        pending.alignMode, pending.sourceProgress,
      );
      this.host.scrollSync.applyProgrammaticScroll(side, clamped, pending.fromSide);
      return clamped;
    };

    const appliedTop = alignToTarget();
    this.host.scheduleOverlayRedraw(true);
    this.host.debugLog("scroll-slice-aligned", {
      side, trigger, targetBlockID: pending.targetBlockID ?? null,
      targetRootIndex: pending.targetRootIndex, mountedRange,
      appliedScrollTop: Math.round(appliedTop), scrollerHeight: Math.round(scrollerRect.height),
    });

    if (this.sliceStabilizeTimers[side] !== undefined) clearTimeout(this.sliceStabilizeTimers[side]);
    this.sliceStabilizeTimers[side] = setTimeout(() => {
      delete this.sliceStabilizeTimers[side];
      if (this.host.closed || this.pendingSliceSync[side] !== pending) return;
      if (targetEl.isConnected) {
        alignToTarget();
        this.host.scheduleOverlayRedraw(false);
      }
      delete this.pendingSliceSync[side];
    }, 270);
  }

  navigateSideToTargetBlock(side: Side, hunk: DiffHunk, cursorLabel: string): void {
    const doc = this.docFor(side);
    const scroller = getScroller(doc);

    if (hunk.kind === "title") {
      this.host.scrollSync.applyProgrammaticScroll(side, 0, side);
      return;
    }

    const resolved = resolveHunkTargetForSide(this.host, hunk, side);
    if (!resolved) return;
    const { targetBlockID, targetRootIndex, tableRowIndex } = resolved;

    const rawMountedBlock = queryLiveBlock(doc, targetBlockID);
    const mountedBlock =
      rawMountedBlock && isBlockRectVisible(rawMountedBlock.getBoundingClientRect()) ? rawMountedBlock : null;
    this.host.debugLog("navigate-hunk", {
      side, cursor: cursorLabel, hunkKey: hunk.key, hunkKind: hunk.kind,
      targetBlockID, targetRootIndex, mounted: Boolean(mountedBlock),
    });

    if (mountedBlock) {
      let focusEl: HTMLElement = mountedBlock;
      if (tableRowIndex !== undefined) {
        const rows = mountedBlock.querySelectorAll<HTMLElement>("tr:not([data-sy-table-virtual-rows])");
        if (tableRowIndex < rows.length) focusEl = rows[tableRowIndex]!;
      }
      const clamped = computeAlignedScrollTop(
        scroller.scrollTop, scroller.scrollHeight, scroller.clientHeight,
        scroller.getBoundingClientRect(), focusEl.getBoundingClientRect(), "center", 0,
      );
      this.host.scrollSync.applyProgrammaticScroll(side, clamped, side);
      return;
    }

    this.pendingSliceSync[side] = {
      targetBlockID, targetRootIndex, sourceProgress: 0, alignMode: "center",
      fromSide: side, expiresAt: Date.now() + 3500, attempts: 1,
    };
    if (doc.tab?.headElement && typeof doc.wndInstance?.switchTab === "function") {
      this.host.withSwappingGuard(() => {
        doc.wndInstance!.switchTab!(doc.tab!.headElement!, false);
      });
    }
    void this.host.bridge.openDocTab({
      app: this.host.app,
      id: targetBlockID,
      action: ["cb-get-hl", "cb-get-context"],
      removeCurrentTab: false,
    });
  }
}
