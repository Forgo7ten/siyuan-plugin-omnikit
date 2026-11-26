import type { Plugin } from "siyuan";
import { describeError } from "../../../core/host/describeError.ts";
import type { KernelClient } from "../../../core/host/KernelClient.ts";
import { Logger } from "../../../core/host/Logger.ts";
import type { HostBridge } from "../host/SiyuanBridge.ts";
import { monotoneAnchors, withinScrollExtent, type ScrollAnchor } from "../model/anchors.ts";
import { comparableTitle } from "../model/conflict.ts";
import { alignUnits, findNearestMatchedBlockID, retainHunkCursor } from "../model/DiffEngine.ts";
import {
  EMPTY_DIFF_COUNTS,
  EMPTY_DIFF_RESULT,
  matchesDiffFilter,
  summarizeDiffCounts,
  type DiffCounts,
  type DiffFilter,
  type DiffHunk,
  type DiffResult,
  type DocumentIdentityLabel,
  type SemanticUnit,
  type SessionStatusKind,
  type Side,
} from "../model/types.ts";
import { ComputeCoordinator } from "./ComputeCoordinator.ts";
import { DiffPainter } from "./DiffPainter.ts";
import { DirtyGate } from "./DirtyGate.ts";
import { KernelSnapshot } from "./KernelSnapshot.ts";
import { ScrollSync } from "./ScrollSync.ts";
import {
  canSwapVisiblePair,
  findVisiblePair,
  swapVisiblePair,
  type VisibleDoc,
} from "./VisiblePair.ts";
import { verifyVisibleParity } from "./VisibleParity.ts";

export interface ToolbarViewState {
  statusKind: SessionStatusKind;
  statusText: string;
  leftDoc: DocumentIdentityLabel;
  rightDoc: DocumentIdentityLabel;
  counts: DiffCounts;
  filter: DiffFilter;
  cursorIndex: number;
  filteredTotal: number;
  syncEnabled: boolean;
  canSwap: boolean;
  canNavigate: boolean;
}

export interface ToolbarActions {
  onPrev: () => void;
  onNext: () => void;
  onToggleFilter: (filter: DiffFilter) => void;
  onToggleSync: () => void;
  onSwap: () => void;
  onRefresh: () => void;
  onClose: () => void;
}

export interface ToolbarHandle {
  update(state: ToolbarViewState): void;
  dispose(): void;
}

export type ToolbarFactory = (
  initialState: ToolbarViewState,
  actions: ToolbarActions,
  t: (key: string, values?: Record<string, string | number>) => string,
) => ToolbarHandle;

export interface DocumentDiffSessionOptions {
  plugin: Plugin;
  kernel: KernelClient;
  bridge: HostBridge;
  logger?: Logger;
  left: VisibleDoc;
  right: VisibleDoc;
  signal: AbortSignal;
  defaultSyncScroll: boolean;
  confirmedConflictID?: string;
  mountToolbar: ToolbarFactory;
  notify: (message: string, type?: "info" | "error") => void;
  t: (key: string, values?: Record<string, string | number>) => string;
  onClosed: () => void;
}

interface ComputedSnapshotResult {
  diff: DiffResult;
  pending: boolean;
  leftUnits: SemanticUnit[];
  rightUnits: SemanticUnit[];
  leftRootIndexByBlockID: Map<string, number>;
  rightRootIndexByBlockID: Map<string, number>;
  leftRootBlockIDs: string[];
  rightRootBlockIDs: string[];
  leftIdentity: DocumentIdentityLabel;
  rightIdentity: DocumentIdentityLabel;
}

interface MountedBlockEntry {
  id: string;
  el: HTMLElement;
  rootIndex?: number;
  hasChildBlock: boolean;
}

interface MountedDomIndex {
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

const VALID_BLOCK_ID_RE = /^\d{14}-[a-zA-Z0-9]{7}$/;
const MAX_PARITY_RETRIES = 4;
const PARITY_RETRY_DELAY_MS = 450;
const SLICE_JUMP_DEBOUNCE_MS = 90;
const DEFAULT_DYNAMIC_LOAD_BLOCKS = 64;
const SCROLL_INTENT_KEYS = new Set([
  "PageUp",
  "PageDown",
  "Home",
  "End",
  "ArrowUp",
  "ArrowDown",
  " ",
]);
const STATIC_SLICE_NAV_KEYS = new Set(["Home", "End", "PageUp", "PageDown"]);

function isBlockRectVisible(rect: DOMRect): boolean {
  return rect.width > 0 || rect.height > 0;
}

function getScroller(doc: VisibleDoc): HTMLElement {
  return (doc.protyle.contentElement ?? doc.protyle.wysiwyg.element.parentElement ?? doc.protyle.element) as HTMLElement;
}

function getDynamicLoadWindowSize(doc: VisibleDoc): number {
  const fromGlobal = (globalThis as { siyuan?: { config?: { editor?: { dynamicLoadBlocks?: number } } } })
    .siyuan?.config?.editor?.dynamicLoadBlocks;
  if (typeof fromGlobal === "number" && Number.isFinite(fromGlobal) && fromGlobal > 0) {
    return fromGlobal;
  }
  const fromDoc = doc.protyle?.options?.size;
  if (typeof fromDoc === "number" && Number.isFinite(fromDoc) && fromDoc > 0) {
    return fromDoc;
  }
  return DEFAULT_DYNAMIC_LOAD_BLOCKS;
}

function queryLiveBlock(doc: VisibleDoc, blockID?: string): HTMLElement | null {
  if (!blockID || !VALID_BLOCK_ID_RE.test(blockID)) return null;
  const wysiwygEl = doc.protyle.wysiwyg.element as HTMLElement;
  const nodes = wysiwygEl.querySelectorAll<HTMLElement>(`[data-node-id="${blockID}"]`);
  for (let i = 0; i < nodes.length; i++) {
    const candidate = nodes[i]!;
    if (!candidate.closest(".protyle-wysiwyg__embed")) return candidate;
  }
  return null;
}

/**
 * Owns one active side-by-side comparison session: coordinates snapshots, parity checks,
 * non-invasive painting, filter chips, cross-viewport jump navigation, scroll sync, and pane swap.
 */
export class DocumentDiffSession {
  private leftDoc: VisibleDoc;
  private rightDoc: VisibleDoc;
  private leftIdentity: DocumentIdentityLabel;
  private rightIdentity: DocumentIdentityLabel;
  private readonly logger: Logger;
  private readonly dirty = new DirtyGate();
  private readonly leftPainter: DiffPainter;
  private readonly rightPainter: DiffPainter;
  private readonly scrollSync: ScrollSync;
  private readonly coordinator: ComputeCoordinator<ComputedSnapshotResult>;
  private readonly toolbar: ToolbarHandle;
  private readonly hostCleanup: Array<() => void> = [];
  private paneCleanups: Array<() => void> = [];
  private mutationObserver?: MutationObserver;
  private resizeObserver?: ResizeObserver;
  private rafHandle?: number;
  private retryTimer?: ReturnType<typeof setTimeout>;
  private readonly sliceJumpTimers: Partial<Record<Side, ReturnType<typeof setTimeout>>> = {};
  private readonly sliceStabilizeTimers: Partial<Record<Side, ReturnType<typeof setTimeout>>> = {};
  private readonly pendingSliceSync: Partial<Record<Side, PendingSliceAlignment>> = {};
  private readonly debugThrottleAt = new Map<string, number>();
  private lastUserScrollSide?: Side;
  private lastUserScrollAt = 0;
  private lastStaticDriverSide?: Side;
  private lastStaticDriverAt = 0;
  private parityRetries = 0;

  private currentDiff: DiffResult = EMPTY_DIFF_RESULT;
  private leftUnits: SemanticUnit[] = [];
  private rightUnits: SemanticUnit[] = [];
  private leftRootIndexByBlockID = new Map<string, number>();
  private rightRootIndexByBlockID = new Map<string, number>();
  private leftRootBlockIDs: string[] = [];
  private rightRootBlockIDs: string[] = [];
  private filter: DiffFilter = "all";
  private cursor = 0;
  private focusedHunkKey?: string;
  private hasNavigated = false;
  private userSyncEnabled: boolean;
  private statusKind: SessionStatusKind = "comparing";
  private errorReason = "";
  private swapping = false;
  private closed = false;

  constructor(private readonly cfg: DocumentDiffSessionOptions) {
    this.logger = cfg.logger ?? Logger.shared;
    this.leftDoc = cfg.left;
    this.rightDoc = cfg.right;
    this.userSyncEnabled = cfg.defaultSyncScroll;
    this.leftIdentity = {
      id: cfg.left.id,
      title: cfg.left.id,
      notebook: cfg.left.notebook,
      notebookName: cfg.bridge.getNotebookName(cfg.left.notebook),
    };
    this.rightIdentity = {
      id: cfg.right.id,
      title: cfg.right.id,
      notebook: cfg.right.notebook,
      notebookName: cfg.bridge.getNotebookName(cfg.right.notebook),
    };

    this.leftPainter = new DiffPainter(this.leftDoc.protyle, "left");
    this.rightPainter = new DiffPainter(this.rightDoc.protyle, "right");
    this.scrollSync = new ScrollSync(
      getScroller(this.leftDoc),
      getScroller(this.rightDoc),
      () => this.computeScrollAnchors(),
      () => performance.now(),
      {
        onUnmappedScroll: (fromSide, readingContentY, own, other, anchorCount) =>
          this.handleUnmappedScroll(fromSide, readingContentY, own, other, anchorCount),
        onBeforeApplyScroll: (targetSide, targetScrollTop, previousScrollTop, sourceSide) =>
          this.prepareTargetProtyleScroll(targetSide, targetScrollTop, previousScrollTop, sourceSide),
        onDebug: (stage, detail, throttleKey) =>
          this.debugLog(stage, detail, throttleKey),
      },
    );
    this.scrollSync.setEnabled(this.userSyncEnabled);
    this.debugLog("session-created", {
      leftID: this.leftDoc.id,
      rightID: this.rightDoc.id,
      defaultSyncScroll: this.userSyncEnabled,
      confirmedConflictID: cfg.confirmedConflictID ?? null,
    });

    this.coordinator = new ComputeCoordinator(
      signal => this.computeLatest(signal),
      result => this.applyComputed(result),
      reason => this.handleComputeError(reason),
      400,
    );

    this.toolbar = cfg.mountToolbar(
      this.buildToolbarState(),
      {
        onPrev: () => this.navigate(-1),
        onNext: () => this.navigate(1),
        onToggleFilter: nextFilter => this.setFilter(nextFilter),
        onToggleSync: () => this.toggleSyncScroll(),
        onSwap: () => this.swapLeftRight(),
        onRefresh: () => {
          this.parityRetries = 0;
          this.requestCompute(true);
        },
        onClose: () => this.dispose(),
      },
      cfg.t,
    );

    this.bindPaneListeners();
    this.bindHostEvents();

    const onAbort = () => this.dispose();
    cfg.signal.addEventListener("abort", onAbort, { once: true });
    this.hostCleanup.push(() => cfg.signal.removeEventListener("abort", onAbort));

    this.coordinator.immediate();
  }

  private bindPaneListeners(): void {
    this.paneCleanups.splice(0).forEach(off => off());
    this.mutationObserver?.disconnect();
    this.resizeObserver?.disconnect();

    const addListener = (
      target: EventTarget,
      type: string,
      handler: EventListener,
      options?: AddEventListenerOptions,
    ) => {
      target.addEventListener(type, handler, options);
      this.paneCleanups.push(() => target.removeEventListener(type, handler, options));
    };

    for (const side of ["left", "right"] as const) {
      const doc = side === "left" ? this.leftDoc : this.rightDoc;
      const protyleEl = doc.protyle.element as HTMLElement;
      const scroller = getScroller(doc);

      addListener(
        protyleEl,
        "compositionstart",
        () => this.coordinator.compositionStart(side),
        { capture: true },
      );
      addListener(
        protyleEl,
        "compositionend",
        () => {
          this.markLocalEdit(side);
          this.coordinator.compositionEnd(side);
        },
        { capture: true },
      );
      for (const editEvent of ["input", "cut", "paste", "drop"] as const) {
        addListener(
          protyleEl,
          editEvent,
          (event: Event) => {
            const target = event.target;
            const isEditableTarget =
              !target ||
              !(typeof Node !== "undefined" && target instanceof Node) ||
              doc.protyle.wysiwyg.element.contains(target) ||
              Boolean(doc.protyle.title?.element?.contains(target));
            if (isEditableTarget) {
              this.markLocalEdit(side);
            }
          },
          { capture: true },
        );
      }
      addListener(
        scroller,
        "scroll",
        () => this.scheduleOverlayRedraw(false),
        { passive: true },
      );

      // Track user scroll/slider gestures in capture phase on `.protyle` (covering `.protyle-scroll`
      // slider and page buttons that stop propagation in bubble phase).
      for (const gestureEvent of ["wheel", "touchstart", "pointerdown"] as const) {
        addListener(
          protyleEl,
          gestureEvent,
          (event: Event) => {
            const target = event.target as HTMLElement | null;
            const inScrollBar = Boolean(target?.closest?.(".protyle-scroll"));
            this.recordUserScrollIntent(side, gestureEvent, inScrollBar);
          },
          { capture: true, passive: true },
        );
      }
      addListener(
        protyleEl,
        "keydown",
        (event: Event) => {
          const key = (event as KeyboardEvent).key;
          if (typeof key === "string" && SCROLL_INTENT_KEYS.has(key)) {
            this.recordUserScrollIntent(side, `keydown:${key}`, STATIC_SLICE_NAV_KEYS.has(key));
          }
        },
        { capture: true, passive: true },
      );
      for (const sliderEvent of ["input", "change"] as const) {
        addListener(
          protyleEl,
          sliderEvent,
          (event: Event) => {
            const target = event.target as HTMLElement | null;
            if (target?.classList?.contains("b3-slider")) {
              this.recordUserScrollIntent(side, `slider-${sliderEvent}`, true);
            }
          },
          { capture: true },
        );
      }
      addListener(
        protyleEl,
        "click",
        (event: Event) => {
          const target = event.target as HTMLElement | null;
          if (target?.closest?.(".protyle-scroll")) {
            this.recordUserScrollIntent(side, "protyle-scroll-click", true);
          }
        },
        { capture: true },
      );
    }

    if (typeof MutationObserver !== "undefined") {
      this.mutationObserver = new MutationObserver(() => {
        if (this.closed || this.dirty.pending || this.statusKind === "comparing") return;
        // Re-apply highlights to newly virtualized blocks from in-memory diff without network fetches.
        this.scheduleOverlayRedraw(true);
      });
      this.mutationObserver.observe(this.leftDoc.protyle.wysiwyg.element, {
        childList: true,
        subtree: true,
      });
      this.mutationObserver.observe(this.rightDoc.protyle.wysiwyg.element, {
        childList: true,
        subtree: true,
      });
    }

    if (typeof ResizeObserver !== "undefined") {
      this.resizeObserver = new ResizeObserver(() => {
        if (this.closed) return;
        this.scheduleOverlayRedraw(false);
      });
      this.resizeObserver.observe(this.leftDoc.protyle.element);
      this.resizeObserver.observe(this.rightDoc.protyle.element);
    }
  }

  private bindHostEvents(): void {
    const onWsMain = (event: CustomEvent<any>) => {
      if (this.closed) return;
      const cmd = event.detail?.cmd ?? event.detail?.data?.cmd;
      if (
        cmd === "transactions" ||
        cmd === "reload" ||
        cmd === "reloaddoc" ||
        cmd === "syncMergeResult" ||
        cmd === "rename" ||
        cmd === "removeDoc"
      ) {
        if (cmd === "removeDoc") {
          const removedIds: unknown = event.detail?.data?.ids;
          if (
            Array.isArray(removedIds) &&
            (removedIds.includes(this.leftDoc.id) || removedIds.includes(this.rightDoc.id))
          ) {
            this.cfg.notify(this.cfg.t("diff.notice.docRemoved"), "error");
            this.dispose();
            return;
          }
        }
        this.requestCompute(false);
      }
    };

    const onDynamicLoad = (event: CustomEvent<any>) => {
      if (this.closed) return;
      const el = event.detail?.protyle?.element;
      const side: Side | undefined =
        el === this.leftDoc.protyle.element
          ? "left"
          : el === this.rightDoc.protyle.element
            ? "right"
            : undefined;
      if (!side) return;
      if (!this.dirty.pending) {
        this.scheduleOverlayRedraw(true);
      }
      this.handleProtyleSliceLoaded(side, "loaded-protyle-dynamic");
    };

    const onStaticLoad = (event: CustomEvent<any>) => {
      if (this.closed) return;
      const el = event.detail?.protyle?.element;
      const side: Side | undefined =
        el === this.leftDoc.protyle.element
          ? "left"
          : el === this.rightDoc.protyle.element
            ? "right"
            : undefined;
      if (!side) return;
      if (!this.isPairStillLive()) {
        this.dispose();
        return;
      }
      if (this.dirty.pending || this.statusKind === "comparing" || this.statusKind === "failed") {
        this.requestCompute(false);
        return;
      }
      this.scheduleOverlayRedraw(true);
      this.handleProtyleSliceLoaded(side, "loaded-protyle-static");
    };

    const onSwitchProtyle = () => {
      if (this.closed || this.swapping) return;
      if (!this.isPairStillLive()) {
        this.dispose();
      }
    };

    const onSyncEnd = () => {
      if (!this.closed) {
        this.requestCompute(false);
      }
    };

    const onDestroyProtyle = (event: CustomEvent<any>) => {
      const el = event.detail?.protyle?.element;
      if (el === this.leftDoc.protyle.element || el === this.rightDoc.protyle.element) {
        this.dispose();
      }
    };

    this.cfg.plugin.eventBus.on("ws-main", onWsMain);
    this.cfg.plugin.eventBus.on("loaded-protyle-dynamic", onDynamicLoad);
    this.cfg.plugin.eventBus.on("loaded-protyle-static", onStaticLoad);
    this.cfg.plugin.eventBus.on("switch-protyle", onSwitchProtyle);
    this.cfg.plugin.eventBus.on("sync-end", onSyncEnd);
    this.cfg.plugin.eventBus.on("destroy-protyle", onDestroyProtyle);

    this.hostCleanup.push(
      () => this.cfg.plugin.eventBus.off("ws-main", onWsMain),
      () => this.cfg.plugin.eventBus.off("loaded-protyle-dynamic", onDynamicLoad),
      () => this.cfg.plugin.eventBus.off("loaded-protyle-static", onStaticLoad),
      () => this.cfg.plugin.eventBus.off("switch-protyle", onSwitchProtyle),
      () => this.cfg.plugin.eventBus.off("sync-end", onSyncEnd),
      () => this.cfg.plugin.eventBus.off("destroy-protyle", onDestroyProtyle),
    );
  }

  private scheduleOverlayRedraw(rebindRanges: boolean): void {
    if (this.closed) return;
    const run = () => {
      this.rafHandle = undefined;
      if (this.closed) return;
      if (rebindRanges && !this.dirty.pending && (this.statusKind === "diff" || this.statusKind === "unresolved")) {
        this.leftPainter.paint(this.currentDiff, this.leftUnits, this.filter, this.focusedHunkKey);
        this.rightPainter.paint(this.currentDiff, this.rightUnits, this.filter, this.focusedHunkKey);
      } else {
        this.leftPainter.redrawOverlay();
        this.rightPainter.redrawOverlay();
      }
    };
    if (typeof requestAnimationFrame === "function") {
      if (this.rafHandle !== undefined) cancelAnimationFrame(this.rafHandle);
      this.rafHandle = requestAnimationFrame(run);
    } else {
      run();
    }
  }

  private isPairStillLive(): boolean {
    const pair = findVisiblePair(this.cfg.bridge);
    if (!pair) return false;
    return (
      pair[0].id === this.leftDoc.id &&
      pair[1].id === this.rightDoc.id &&
      pair[0].protyle === this.leftDoc.protyle &&
      pair[1].protyle === this.rightDoc.protyle
    );
  }

  private filteredHunks(): DiffHunk[] {
    return this.currentDiff.hunks.filter(hunk => matchesDiffFilter(hunk, this.filter));
  }

  private formatStatusText(filteredLen: number): string {
    const { t } = this.cfg;
    switch (this.statusKind) {
      case "comparing":
        return t("diff.status.comparing");
      case "unconfirmed":
        return t("diff.status.unconfirmed");
      case "equal":
        return t("diff.status.equal");
      case "failed":
        return t("diff.status.failed", { reason: this.errorReason || t("diff.error.unknown") });
      case "unresolved":
        return t("diff.status.unresolved", {
          confirmed: this.currentDiff.counts.confirmedDiff,
          unresolved: this.currentDiff.counts.unresolved,
        });
      case "diff":
        if (filteredLen === 0) {
          return t("diff.status.filterEmpty");
        }
        return t("diff.status.diff", {
          current: this.hasNavigated ? this.cursor + 1 : 0,
          total: filteredLen,
        });
    }
  }

  private buildToolbarState(): ToolbarViewState {
    const visibleHunks = this.filteredHunks();
    const canNavigate =
      !this.dirty.pending &&
      (this.statusKind === "diff" || this.statusKind === "unresolved") &&
      visibleHunks.length > 0;

    return {
      statusKind: this.statusKind,
      statusText: this.formatStatusText(visibleHunks.length),
      leftDoc: this.leftIdentity,
      rightDoc: this.rightIdentity,
      counts: this.dirty.pending || this.statusKind === "failed"
        ? { ...EMPTY_DIFF_COUNTS }
        : this.currentDiff.counts,
      filter: this.filter,
      cursorIndex: this.hasNavigated && visibleHunks.length > 0 ? this.cursor + 1 : 0,
      filteredTotal: visibleHunks.length,
      syncEnabled: this.userSyncEnabled,
      canSwap: canSwapVisiblePair(this.leftDoc, this.rightDoc),
      canNavigate,
    };
  }

  private pushToolbarState(): void {
    if (this.closed) return;
    this.toolbar.update(this.buildToolbarState());
  }

  private markLocalEdit(side: Side): void {
    if (this.closed) return;
    this.dirty.edit(side);
    this.parityRetries = 0;
    if (this.retryTimer !== undefined) {
      clearTimeout(this.retryTimer);
      this.retryTimer = undefined;
    }
    this.statusKind = "unconfirmed";
    this.leftPainter.clear();
    this.rightPainter.clear();
    this.scrollSync.setEnabled(false);
    this.pushToolbarState();
    this.coordinator.request();
  }

  private requestCompute(immediate: boolean): void {
    if (this.closed) return;
    if (!this.isPairStillLive()) {
      this.dispose();
      return;
    }
    if (this.retryTimer !== undefined) {
      clearTimeout(this.retryTimer);
      this.retryTimer = undefined;
    }
    if (!this.dirty.pending) {
      this.statusKind = "comparing";
      this.pushToolbarState();
    }
    if (immediate) this.coordinator.immediate();
    else this.coordinator.request();
  }

  private async computeLatest(signal: AbortSignal): Promise<ComputedSnapshotResult> {
    if (!this.isPairStillLive()) {
      throw new Error(this.cfg.t("diff.error.pairChanged"));
    }
    const capturedGate = this.dirty.capture();
    const reader = new KernelSnapshot(this.cfg.kernel, signal);
    const [leftSnap, rightSnap] = await Promise.all([
      reader.readSnapshot(this.leftDoc.id, this.leftDoc.notebook, this.leftDoc.protyle),
      reader.readSnapshot(this.rightDoc.id, this.rightDoc.notebook, this.rightDoc.protyle),
    ]);
    if (signal.aborted) {
      throw new DOMException("Aborted", "AbortError");
    }

    const leftNeedsParity = this.dirty.isSidePending("left");
    const rightNeedsParity = this.dirty.isSidePending("right");
    const forceAcknowledge = this.parityRetries >= MAX_PARITY_RETRIES;
    const leftVerified = !leftNeedsParity || verifyVisibleParity(this.leftDoc.protyle, leftSnap);
    const rightVerified = !rightNeedsParity || verifyVisibleParity(this.rightDoc.protyle, rightSnap);
    this.dirty.acknowledge("left", capturedGate.left, leftVerified || forceAcknowledge);
    this.dirty.acknowledge("right", capturedGate.right, rightVerified || forceAcknowledge);

    const diff = alignUnits(leftSnap.units, rightSnap.units);
    const cmpLeftTitle = comparableTitle(leftSnap.id, leftSnap.title, this.cfg.confirmedConflictID);
    const cmpRightTitle = comparableTitle(rightSnap.id, rightSnap.title, this.cfg.confirmedConflictID);

    if (cmpLeftTitle !== cmpRightTitle) {
      const makeTitleUnit = (title: string): SemanticUnit => ({
        kind: "Title",
        context: "",
        text: title,
        format: "",
        target: "",
        line: 0,
        reliable: true,
      });
      const titleHunk: DiffHunk = {
        kind: "title",
        left: [makeTitleUnit(cmpLeftTitle)],
        right: [makeTitleUnit(cmpRightTitle)],
        leftIndex: 0,
        rightIndex: 0,
        key: "title",
      };
      const mergedHunks = [titleHunk, ...diff.hunks];
      diff.hunks = mergedHunks;
      diff.counts = summarizeDiffCounts(mergedHunks);
    }

    return {
      diff,
      pending: this.dirty.pending,
      leftUnits: leftSnap.units,
      rightUnits: rightSnap.units,
      leftRootIndexByBlockID: leftSnap.rootBlockIndexByBlockID,
      rightRootIndexByBlockID: rightSnap.rootBlockIndexByBlockID,
      leftRootBlockIDs: leftSnap.rootBlockIDs,
      rightRootBlockIDs: rightSnap.rootBlockIDs,
      leftIdentity: {
        id: leftSnap.id,
        title: leftSnap.title,
        notebook: leftSnap.notebook,
        notebookName: this.cfg.bridge.getNotebookName(leftSnap.notebook),
        hPath: leftSnap.hPath,
      },
      rightIdentity: {
        id: rightSnap.id,
        title: rightSnap.title,
        notebook: rightSnap.notebook,
        notebookName: this.cfg.bridge.getNotebookName(rightSnap.notebook),
        hPath: rightSnap.hPath,
      },
    };
  }

  private applyComputed(result: ComputedSnapshotResult): void {
    if (this.closed || !this.isPairStillLive()) {
      this.dispose();
      return;
    }
    this.leftIdentity = result.leftIdentity;
    this.rightIdentity = result.rightIdentity;

    if (result.pending) {
      this.statusKind = "unconfirmed";
      this.leftPainter.clear();
      this.rightPainter.clear();
      this.scrollSync.setEnabled(false);
      this.pushToolbarState();
      if (this.parityRetries < MAX_PARITY_RETRIES) {
        this.parityRetries++;
        this.retryTimer = setTimeout(() => {
          this.retryTimer = undefined;
          if (!this.closed) this.coordinator.immediate();
        }, PARITY_RETRY_DELAY_MS);
      }
      return;
    }

    this.parityRetries = 0;
    const prevFiltered = this.filteredHunks();
    const prevActiveHunk = this.hasNavigated ? prevFiltered[this.cursor] : undefined;

    this.currentDiff = result.diff;
    this.leftUnits = result.leftUnits;
    this.rightUnits = result.rightUnits;
    this.leftRootIndexByBlockID = result.leftRootIndexByBlockID;
    this.rightRootIndexByBlockID = result.rightRootIndexByBlockID;
    this.leftRootBlockIDs = result.leftRootBlockIDs;
    this.rightRootBlockIDs = result.rightRootBlockIDs;

    // Reset filter to "all" if the previously selected category now has 0 items (except when user explicitly checks).
    const nextFiltered = this.filteredHunks();
    if (nextFiltered.length === 0 && this.filter !== "all" && this.currentDiff.hunks.length > 0) {
      this.filter = "all";
    }
    const finalFiltered = this.filteredHunks();
    this.cursor = retainHunkCursor(prevActiveHunk, finalFiltered);
    if (finalFiltered.length === 0) {
      this.hasNavigated = false;
      this.focusedHunkKey = undefined;
    } else if (this.hasNavigated) {
      this.focusedHunkKey = finalFiltered[this.cursor]?.key;
    }

    if (this.currentDiff.unresolved) {
      this.statusKind = "unresolved";
    } else if (this.currentDiff.hunks.length > 0) {
      this.statusKind = "diff";
    } else {
      this.statusKind = "equal";
    }

    this.leftPainter.paint(this.currentDiff, this.leftUnits, this.filter, this.focusedHunkKey);
    this.rightPainter.paint(this.currentDiff, this.rightUnits, this.filter, this.focusedHunkKey);
    this.scrollSync.setEnabled(this.userSyncEnabled);
    this.pushToolbarState();

    if (this.isDebugActive()) {
      const leftMounted = this.inspectMountedDom("left");
      const rightMounted = this.inspectMountedDom("right");
      this.debugLog("snapshot-applied", {
        statusKind: this.statusKind,
        counts: this.currentDiff.counts,
        matches: this.currentDiff.matches.length,
        leftRootBlocks: this.leftRootBlockIDs.length,
        rightRootBlocks: this.rightRootBlockIDs.length,
        leftMountedRange: `${leftMounted.minRootIndex}..${leftMounted.maxRootIndex}/${this.leftRootBlockIDs.length}`,
        rightMountedRange: `${rightMounted.minRootIndex}..${rightMounted.maxRootIndex}/${this.rightRootBlockIDs.length}`,
      });
    }
  }

  private handleComputeError(error: unknown): void {
    if (this.closed) return;
    if (!this.isPairStillLive()) {
      this.dispose();
      return;
    }
    this.errorReason = describeError(error);
    this.statusKind = "failed";
    this.leftPainter.clear();
    this.rightPainter.clear();
    this.scrollSync.setEnabled(false);
    this.pushToolbarState();
  }

  private setFilter(nextFilter: DiffFilter): void {
    if (this.closed || this.dirty.pending) return;
    this.filter = this.filter === nextFilter ? "all" : nextFilter;
    this.cursor = 0;
    this.hasNavigated = false;
    this.focusedHunkKey = undefined;
    this.leftPainter.paint(this.currentDiff, this.leftUnits, this.filter, undefined);
    this.rightPainter.paint(this.currentDiff, this.rightUnits, this.filter, undefined);
    this.pushToolbarState();
    if (this.filteredHunks().length > 0) {
      this.navigate(1);
    }
  }

  private toggleSyncScroll(): void {
    if (this.closed) return;
    this.userSyncEnabled = !this.userSyncEnabled;
    this.scrollSync.setEnabled(this.userSyncEnabled && !this.dirty.pending && this.statusKind !== "failed");
    this.pushToolbarState();
  }

  private swapLeftRight(): void {
    if (this.closed || this.swapping) return;
    this.swapping = true;
    this.clearPendingSliceTimers();
    try {
      const [nextLeft, nextRight] = swapVisiblePair(this.leftDoc, this.rightDoc, this.cfg.bridge);
      this.leftDoc = nextLeft;
      this.rightDoc = nextRight;
      [this.leftIdentity, this.rightIdentity] = [this.rightIdentity, this.leftIdentity];
      this.dirty.swapSides();
      this.coordinator.swapSides();

      this.leftPainter.rebind(this.leftDoc.protyle, "left");
      this.rightPainter.rebind(this.rightDoc.protyle, "right");
      this.scrollSync.rebindScrollers(getScroller(this.leftDoc), getScroller(this.rightDoc));
      this.bindPaneListeners();
    } catch {
      this.swapping = false;
      this.cfg.notify(this.cfg.t("diff.notice.swapManualHint"), "info");
      this.pushToolbarState();
      return;
    }
    this.swapping = false;
    this.debugLog("swap-left-right", {
      leftID: this.leftDoc.id,
      rightID: this.rightDoc.id,
    });
    this.requestCompute(true);
  }

  private isDebugActive(): boolean {
    return (
      this.logger.isDebugEnabled ||
      (globalThis as { __OMNIKIT_DIFF_DEBUG__?: boolean }).__OMNIKIT_DIFF_DEBUG__ === true
    );
  }

  private debugLog(stage: string, detail: Record<string, unknown>, throttleKey?: string, throttleMs = 220): void {
    if (!this.isDebugActive()) return;
    if (throttleKey) {
      const now = Date.now();
      const prev = this.debugThrottleAt.get(throttleKey) ?? 0;
      if (now - prev < throttleMs) return;
      this.debugThrottleAt.set(throttleKey, now);
    }
    if (this.logger.isDebugEnabled) {
      this.logger.debug(`[document-diff] ${stage}`, detail);
    } else {
      console.debug(`[OmniKit][debug][document-diff] ${stage}`, detail);
    }
  }

  private recordUserScrollIntent(side: Side, trigger: string, isStaticSliceTrigger = false): void {
    if (this.closed) return;
    const now = Date.now();
    this.lastUserScrollSide = side;
    this.lastUserScrollAt = now;
    if (isStaticSliceTrigger) {
      this.lastStaticDriverSide = side;
      this.lastStaticDriverAt = now;
    }
    this.scrollSync.notifyUserIntent(side);
    // Cancel any pending programmatic slice alignment targeting `side` when the user explicitly
    // scrolls or clicks `.protyle-scroll` on `side` (ignore plain editor clicks inside text).
    if (trigger !== "pointerdown" || isStaticSliceTrigger) {
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
    this.debugLog("user-scroll-intent", { side, trigger, isStaticSliceTrigger }, `intent:${side}:${trigger}`, 300);
  }

  private clearPendingSliceTimers(): void {
    for (const side of ["left", "right"] as const) {
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
  }

  private inspectMountedDom(side: Side): MountedDomIndex {
    const doc = side === "left" ? this.leftDoc : this.rightDoc;
    const rootIndexMap = side === "left" ? this.leftRootIndexByBlockID : this.rightRootIndexByBlockID;
    const totalRootBlocks = side === "left" ? this.leftRootBlockIDs.length : this.rightRootBlockIDs.length;
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

    if (!Number.isFinite(minRootIndex)) {
      minRootIndex = 0;
    }

    const children = wysiwygEl.children;
    const firstChild = children && children.length > 0 ? (children[0] as HTMLElement) : undefined;
    const lastChild = children && children.length > 0 ? (children[children.length - 1] as HTMLElement) : undefined;
    const trailingFoldedHeading =
      lastChild?.getAttribute?.("data-type") === "NodeHeading" &&
      lastChild?.getAttribute?.("fold") === "1"
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

  private computeScrollAnchors(): ScrollAnchor[] {
    if (this.dirty.pending || (this.currentDiff.matches.length === 0 && this.currentDiff.hunks.length === 0)) {
      return [];
    }
    const leftMounted = this.inspectMountedDom("left");
    const rightMounted = this.inspectMountedDom("right");
    if (leftMounted.byId.size === 0 || rightMounted.byId.size === 0) {
      return [];
    }

    const leftScroller = getScroller(this.leftDoc);
    const rightScroller = getScroller(this.rightDoc);
    const leftScrollerRect = leftScroller.getBoundingClientRect();
    const rightScrollerRect = rightScroller.getBoundingClientRect();
    const leftBase = leftScroller.scrollTop - leftScrollerRect.top;
    const rightBase = rightScroller.scrollTop - rightScrollerRect.top;

    const seenPairs = new Set<string>();
    const raw: ScrollAnchor[] = [];
    const tryAddPair = (leftBlockID?: string, rightBlockID?: string): void => {
      if (!leftBlockID || !rightBlockID) return;
      const pairKey = `${leftBlockID}:${rightBlockID}`;
      if (seenPairs.has(pairKey)) return;
      seenPairs.add(pairKey);
      const leftEl = leftMounted.byId.get(leftBlockID);
      if (!leftEl) return;
      const rightEl = rightMounted.byId.get(rightBlockID);
      if (!rightEl) return;
      const leftRect = leftEl.getBoundingClientRect();
      const rightRect = rightEl.getBoundingClientRect();
      // Exclude `display: none` blocks (e.g. folded list/callout children or inactive tabs) whose rect is 0x0.
      if (!isBlockRectVisible(leftRect) || !isBlockRectVisible(rightRect)) return;
      raw.push({
        leftY: leftRect.top + leftBase,
        rightY: rightRect.top + rightBase,
      });
    };

    for (const match of this.currentDiff.matches) {
      tryAddPair(match.leftBlockID, match.rightBlockID);
    }
    for (const hunk of this.currentDiff.hunks) {
      if (hunk.kind === "modified" || hunk.kind === "unresolved") {
        tryAddPair(hunk.left[0]?.blockID, hunk.right[0]?.blockID);
      }
    }
    return monotoneAnchors(raw);
  }

  private findReadingBlock(
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
        // Pre-order traversal visits outer containers before inner leaf blocks:
        // keep updating so the deepest visible child block spanning `readingViewportY` wins!
        spanningEntry = entry;
        spanningRect = rect;
        continue;
      }

      const dist = readingViewportY < rect.top
        ? rect.top - readingViewportY
        : readingViewportY - rect.bottom;
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
    const height = Math.max(1, bestRect.height);
    const progress = Math.max(0, Math.min(1, (readingViewportY - bestRect.top) / height));
    return {
      id: bestEntry.id,
      el: bestEntry.el,
      rootIndex: bestEntry.rootIndex,
      progress,
    };
  }

  private mapBlockAcrossDiff(
    fromSide: Side,
    sourceBlockID: string,
    sourceRootIndex?: number,
  ): { targetBlockID?: string; targetRootIndex: number; mappingKind: string } | undefined {
    const toSide: Side = fromSide === "left" ? "right" : "left";
    const ownUnits = fromSide === "left" ? this.leftUnits : this.rightUnits;
    const otherUnits = fromSide === "left" ? this.rightUnits : this.leftUnits;
    const ownRootMap = fromSide === "left" ? this.leftRootIndexByBlockID : this.rightRootIndexByBlockID;
    const otherRootMap = fromSide === "left" ? this.rightRootIndexByBlockID : this.leftRootIndexByBlockID;
    const ownRootIDs = fromSide === "left" ? this.leftRootBlockIDs : this.rightRootBlockIDs;
    const otherRootIDs = fromSide === "left" ? this.rightRootBlockIDs : this.leftRootBlockIDs;
    if (otherRootIDs.length === 0 && otherUnits.length === 0) return undefined;

    const resolveTargetRootIndex = (targetBlockID?: string, fallbackRatio = 0): number => {
      if (targetBlockID) {
        const mapped = otherRootMap.get(targetBlockID);
        if (mapped !== undefined) return mapped;
      }
      if (otherRootIDs.length === 0) return 1;
      return Math.max(1, Math.min(otherRootIDs.length, Math.round(fallbackRatio * otherRootIDs.length) || 1));
    };

    const srcRootIdx = sourceRootIndex ?? ownRootMap.get(sourceBlockID) ?? 1;
    const ratio = ownRootIDs.length > 1 ? (srcRootIdx - 1) / (ownRootIDs.length - 1) : 0;

    // 1. Direct matched block in `currentDiff.matches`
    for (const match of this.currentDiff.matches) {
      const ownID = fromSide === "left" ? match.leftBlockID : match.rightBlockID;
      const peerID = fromSide === "left" ? match.rightBlockID : match.leftBlockID;
      if (ownID === sourceBlockID && peerID) {
        return {
          targetBlockID: peerID,
          targetRootIndex: resolveTargetRootIndex(peerID, ratio),
          mappingKind: "exact-match",
        };
      }
    }

    // 2. Paired unit or context match for a diff hunk containing `sourceBlockID`
    for (const hunk of this.currentDiff.hunks) {
      const ownHunkUnits = fromSide === "left" ? hunk.left : hunk.right;
      const peerHunkUnits = fromSide === "left" ? hunk.right : hunk.left;
      const unitOffset = ownHunkUnits.findIndex(u => u.blockID === sourceBlockID);
      if (unitOffset >= 0) {
        if (peerHunkUnits.length > 0) {
          const peerIdx = Math.min(
            peerHunkUnits.length - 1,
            Math.floor((unitOffset / Math.max(1, ownHunkUnits.length)) * peerHunkUnits.length),
          );
          const peerID = peerHunkUnits[peerIdx]?.blockID;
          if (peerID) {
            return {
              targetBlockID: peerID,
              targetRootIndex: resolveTargetRootIndex(peerID, ratio),
              mappingKind: `hunk-${hunk.kind}`,
            };
          }
        }
        const contextID = findNearestMatchedBlockID(this.currentDiff.matches, hunk, toSide);
        if (contextID) {
          return {
            targetBlockID: contextID,
            targetRootIndex: resolveTargetRootIndex(contextID, ratio),
            mappingKind: `hunk-context-${hunk.kind}`,
          };
        }
      }
    }

    // 3. Nearest matched anchor by logical unit position or root block index
    let srcUnitIndex = ownUnits.findIndex(u => u.blockID === sourceBlockID);
    if (srcUnitIndex < 0 && ownUnits.length > 0) {
      srcUnitIndex = Math.round(ratio * (ownUnits.length - 1));
    }
    if (srcUnitIndex >= 0 && this.currentDiff.matches.length > 0) {
      let bestMatch = this.currentDiff.matches[0]!;
      let bestDist = Number.POSITIVE_INFINITY;
      for (const m of this.currentDiff.matches) {
        const pos = fromSide === "left" ? m.leftIndex : m.rightIndex;
        const peerID = fromSide === "left" ? m.rightBlockID : m.leftBlockID;
        if (!peerID) continue;
        const dist = Math.abs(pos - srcUnitIndex);
        if (dist < bestDist) {
          bestDist = dist;
          bestMatch = m;
        }
      }
      const peerID = fromSide === "left" ? bestMatch.rightBlockID : bestMatch.leftBlockID;
      if (peerID) {
        return {
          targetBlockID: peerID,
          targetRootIndex: resolveTargetRootIndex(peerID, ratio),
          mappingKind: "nearest-match",
        };
      }
    }

    // 4. Proportional root-block fallback
    const targetRootIndex = resolveTargetRootIndex(undefined, ratio);
    const targetBlockID = otherRootIDs[targetRootIndex - 1] ?? otherUnits[0]?.blockID;
    return {
      targetBlockID,
      targetRootIndex,
      mappingKind: "proportional-root",
    };
  }

  private resolveVisibleMountedOrAncestor(el: HTMLElement | undefined, boundary: HTMLElement): HTMLElement | undefined {
    let cur: HTMLElement | null | undefined = el;
    while (cur && cur !== boundary) {
      if (cur.getAttribute?.("data-node-id") && isBlockRectVisible(cur.getBoundingClientRect())) {
        return cur;
      }
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
      const direct = mounted.byId.get(targetBlockID);
      if (direct) {
        const visible = this.resolveVisibleMountedOrAncestor(direct, wysiwygEl);
        if (visible) return visible;
      }
    }
    if (
      mounted.minRootIndex > 0 &&
      targetRootIndex >= mounted.minRootIndex &&
      targetRootIndex <= mounted.maxRootIndex
    ) {
      // Target block is inside the currently loaded slice range (e.g. hidden under a folded heading):
      // pick the nearest visible mounted preceding/ancestor block in `[minRootIndex .. targetRootIndex]`.
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
      // All remaining blocks past `maxRootIndex` are hidden under a trailing folded heading.
      return mounted.trailingFoldedHeading;
    }
    return undefined;
  }

  private handleUnmappedScroll(
    fromSide: Side,
    readingContentY: number,
    _own: unknown,
    _other: unknown,
    anchorCount: number,
  ): number | null {
    if (this.closed || this.dirty.pending) return null;
    const toSide: Side = fromSide === "left" ? "right" : "left";
    const ownDoc = fromSide === "left" ? this.leftDoc : this.rightDoc;
    const otherDoc = fromSide === "left" ? this.rightDoc : this.leftDoc;
    const ownScroller = getScroller(ownDoc);
    const otherScroller = getScroller(otherDoc);
    const ownScrollerRect = ownScroller.getBoundingClientRect();
    const otherScrollerRect = otherScroller.getBoundingClientRect();
    const readingOffset = Math.min(48, Math.max(0, ownScroller.clientHeight * 0.15));

    const ownMounted = this.inspectMountedDom(fromSide);
    const otherMounted = this.inspectMountedDom(toSide);
    const readingBlock = this.findReadingBlock(ownMounted, ownScrollerRect, readingOffset);
    if (!readingBlock) return null;

    const mapped = this.mapBlockAcrossDiff(fromSide, readingBlock.id, readingBlock.rootIndex);
    if (!mapped) return null;

    const otherWysiwygEl = otherDoc.protyle.wysiwyg.element as HTMLElement;
    const mountedTargetEl = this.findMountedTargetElement(
      otherMounted,
      otherWysiwygEl,
      mapped.targetBlockID,
      mapped.targetRootIndex,
    );
    if (mountedTargetEl) {
      const targetRect = mountedTargetEl.getBoundingClientRect();
      const targetContentTop = targetRect.top - otherScrollerRect.top + otherScroller.scrollTop;
      const mappedY = targetContentTop + readingBlock.progress * Math.max(1, targetRect.height);
      this.debugLog(
        "scroll-unmapped-mounted-hit",
        {
          from: fromSide,
          to: toSide,
          readingContentY: Math.round(readingContentY),
          anchorCount,
          sourceBlockID: readingBlock.id,
          sourceRootIndex: readingBlock.rootIndex ?? null,
          targetBlockID: mapped.targetBlockID ?? null,
          targetRootIndex: mapped.targetRootIndex,
          mappingKind: mapped.mappingKind,
          mappedY: Math.round(mappedY),
        },
        `unmapped-hit:${fromSide}`,
      );
      return mappedY;
    }

    // The target block is outside `toSide`'s currently mounted virtual scroll window!
    const otherTotalRoots = toSide === "left" ? this.leftRootBlockIDs.length : this.rightRootBlockIDs.length;
    const ownTotalRoots = fromSide === "left" ? this.leftRootBlockIDs.length : this.rightRootBlockIDs.length;
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

    const windowSize = getDynamicLoadWindowSize(otherDoc);
    const adjacentThreshold = Math.max(6, Math.min(16, Math.floor(windowSize / 4)));
    const isBelowLoaded = otherMounted.maxRootIndex > 0 && mapped.targetRootIndex > otherMounted.maxRootIndex;
    const isAboveLoaded = otherMounted.minRootIndex > 0 && mapped.targetRootIndex < otherMounted.minRootIndex;
    const distance = isBelowLoaded
      ? mapped.targetRootIndex - otherMounted.maxRootIndex
      : isAboveLoaded
        ? otherMounted.minRootIndex - mapped.targetRootIndex
        : Number.POSITIVE_INFINITY;

    if (
      distance <= adjacentThreshold &&
      ((isBelowLoaded && !otherMounted.bottomBoundaryLoaded) || (isAboveLoaded && !otherMounted.topBoundaryLoaded))
    ) {
      const mode: 1 | 2 = isAboveLoaded ? 1 : 2;
      const edgeTop = isAboveLoaded
        ? 1
        : Math.max(0, otherScroller.scrollHeight - otherScroller.clientHeight);
      this.scrollSync.applyProgrammaticScroll(toSide, edgeTop, fromSide);
      const dynamicAlreadyInFlight = Boolean(otherWysiwygEl.getAttribute?.("data-top"));
      const started = dynamicAlreadyInFlight ? false : this.triggerProtyleDynamicLoad(otherDoc, mode);
      this.debugLog(
        "scroll-cross-slice-dynamic",
        {
          from: fromSide,
          to: toSide,
          mode,
          started,
          dynamicAlreadyInFlight,
          sourceBlockID: readingBlock.id,
          sourceRootIndex: readingBlock.rootIndex ?? null,
          targetBlockID: mapped.targetBlockID ?? null,
          targetRootIndex: mapped.targetRootIndex,
          mappingKind: mapped.mappingKind,
          ownMounted: `${ownMounted.minRootIndex}..${ownMounted.maxRootIndex}/${ownTotalRoots}`,
          otherMounted: `${otherMounted.minRootIndex}..${otherMounted.maxRootIndex}/${otherTotalRoots}`,
        },
        `cross-dyn:${toSide}:${mode}`,
      );
      if (started || dynamicAlreadyInFlight) {
        return null;
      }
    }

    this.scheduleDisjointSliceJump(
      toSide,
      mapped.targetRootIndex,
      mapped.targetBlockID,
      `${ownMounted.minRootIndex}..${ownMounted.maxRootIndex}/${ownTotalRoots}`,
      `${otherMounted.minRootIndex}..${otherMounted.maxRootIndex}/${otherTotalRoots}`,
      mapped.mappingKind,
    );
    return null;
  }

  private prepareTargetProtyleScroll(
    targetSide: Side,
    targetScrollTop: number,
    previousScrollTop: number,
    _sourceSide: Side,
  ): number {
    const doc = targetSide === "left" ? this.leftDoc : this.rightDoc;
    const scroller = getScroller(doc);
    const scrollObj = doc.protyle?.scroll;
    const mounted = this.inspectMountedDom(targetSide);
    let adjustedTop = targetScrollTop;

    // SiYuan's `scrollEvent` (`app/src/protyle/scroll/event.ts:93`) ignores `scrollTop === 0` when scrolling up;
    // clamping to `1` when top blocks are still unloaded lets SiYuan detect upward boundary arrival.
    if (adjustedTop < previousScrollTop && adjustedTop < 1 && !mounted.topBoundaryLoaded) {
      adjustedTop = 1;
    }

    if (scrollObj && typeof scrollObj.lastScrollTop === "number") {
      if (adjustedTop > previousScrollTop) {
        // Prevent SiYuan (`app/src/protyle/scroll/event.ts:114`) from misidentifying programmatic sync as a fast
        // scrollbar drag (`lastScrollTop > 768 && scrollTop > lastScrollTop * 2`) and reverting `scrollTop`.
        scrollObj.lastScrollTop = Math.max(0, Math.floor(adjustedTop - 16));
      } else if (adjustedTop < previousScrollTop) {
        scrollObj.lastScrollTop = Math.max(Math.ceil(adjustedTop + 16), Math.floor(previousScrollTop));
      } else if (scrollObj.lastScrollTop !== -1) {
        // Restore accurate `lastScrollTop` after SiYuan's 256ms `preventScroll` timer resets it to `headerHeight`.
        scrollObj.lastScrollTop = Math.max(0, Math.floor(adjustedTop));
      }
    }

    // Proactively trigger adjacent dynamic block loading when approaching an unloaded boundary.
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

  private scheduleDisjointSliceJump(
    targetSide: Side,
    targetRootIndex: number,
    targetBlockID: string | undefined,
    ownMountedDesc: string,
    otherMountedDesc: string,
    mappingKind: string,
  ): void {
    if (this.sliceJumpTimers[targetSide] !== undefined) {
      clearTimeout(this.sliceJumpTimers[targetSide]);
    }
    this.sliceJumpTimers[targetSide] = setTimeout(() => {
      delete this.sliceJumpTimers[targetSide];
      if (this.closed) return;
      this.executeDisjointSliceJump(
        targetSide,
        targetRootIndex,
        targetBlockID,
        ownMountedDesc,
        otherMountedDesc,
        mappingKind,
      );
    }, SLICE_JUMP_DEBOUNCE_MS);
  }

  private executeDisjointSliceJump(
    targetSide: Side,
    targetRootIndex: number,
    targetBlockID: string | undefined,
    ownMountedDesc: string,
    otherMountedDesc: string,
    mappingKind: string,
  ): void {
    if (this.closed) return;
    const targetDoc = targetSide === "left" ? this.leftDoc : this.rightDoc;
    const wysiwygEl = targetDoc.protyle?.wysiwyg?.element as HTMLElement | undefined;
    const mounted = this.inspectMountedDom(targetSide);
    if (wysiwygEl && this.findMountedTargetElement(mounted, wysiwygEl, targetBlockID, targetRootIndex)) {
      this.applyPendingSliceAlignment(targetSide, "already-mounted");
      return;
    }

    const totalRootBlocks = Math.max(
      targetSide === "left" ? this.leftRootBlockIDs.length : this.rightRootBlockIDs.length,
      Number(targetDoc.protyle?.block?.blockCount) || 0,
      targetRootIndex,
    );
    const windowSize = getDynamicLoadWindowSize(targetDoc);
    const mountedSpan =
      mounted.maxRootIndex >= mounted.minRootIndex && mounted.minRootIndex > 0
        ? mounted.maxRootIndex - mounted.minRootIndex + 1
        : windowSize;
    const effectiveSliceSize = Math.max(4, Math.min(windowSize, mountedSpan));
    const leadBlocks = Math.max(2, Math.min(8, Math.floor(effectiveSliceSize / 4)));
    const desiredStartIndex = Math.max(1, Math.min(totalRootBlocks, targetRootIndex - leadBlocks));

    const pending = this.pendingSliceSync[targetSide];
    if (pending && pending.lastRequestedStartIndex === desiredStartIndex && pending.attempts >= 1) {
      // Kernel already returned a slice capped before `desiredStartIndex` (e.g. folded heading backtracking):
      // stop re-requesting the identical `desiredStartIndex`.
      return;
    }
    if (pending) {
      pending.lastRequestedStartIndex = desiredStartIndex;
    }

    const scrollObj = targetDoc.protyle?.scroll;
    if (scrollObj && typeof scrollObj.invalidateDynamicLoad === "function") {
      try {
        scrollObj.invalidateDynamicLoad(targetDoc.protyle);
      } catch {
        // ignore
      }
    }

    if (wysiwygEl?.getAttribute?.("data-top")) {
      // Another `setIndex` request is currently in flight on `targetDoc`; `handleProtyleSliceLoaded`
      // will re-trigger once that request finishes and clears `data-top`.
      this.debugLog("scroll-disjoint-slice-queued-busy", {
        targetSide,
        targetRootIndex,
        desiredStartIndex,
        targetBlockID: targetBlockID ?? null,
      });
      return;
    }

    let triggeredVia: "setIndex" | "sliderEvent" | "openDocTab" | "none" = "none";
    const sliderInput =
      (scrollObj?.inputElement as HTMLInputElement | undefined) ??
      (scrollObj?.element?.querySelector?.("input.b3-slider") as HTMLInputElement | null | undefined) ??
      (targetDoc.protyle?.element?.querySelector?.(".protyle-scroll__bar input.b3-slider") as HTMLInputElement | null | undefined);

    if (typeof scrollObj?.setCurrentIndex === "function") {
      try {
        scrollObj.setCurrentIndex(targetDoc.protyle, desiredStartIndex, true);
      } catch {
        // ignore
      }
    }
    if (sliderInput) {
      sliderInput.value = String(desiredStartIndex);
    }

    if (typeof scrollObj?.setIndex === "function") {
      scrollObj.setIndex(targetDoc.protyle);
      triggeredVia = "setIndex";
    } else if (sliderInput && typeof sliderInput.dispatchEvent === "function" && typeof Event === "function") {
      sliderInput.dispatchEvent(new Event("change"));
      triggeredVia = "sliderEvent";
    } else if (targetBlockID && VALID_BLOCK_ID_RE.test(targetBlockID)) {
      void this.cfg.bridge.openDocTab({
        app: this.cfg.plugin.app,
        id: targetBlockID,
        action: ["cb-get-context"],
        keepCursor: false,
        removeCurrentTab: false,
      });
      triggeredVia = "openDocTab";
    }

    this.debugLog("scroll-disjoint-slice-jump", {
      targetSide,
      triggeredVia,
      targetBlockID: targetBlockID ?? null,
      targetRootIndex,
      desiredStartIndex,
      totalRootBlocks,
      mappingKind,
      ownMounted: ownMountedDesc,
      otherMounted: otherMountedDesc,
    });
  }

  private handleProtyleSliceLoaded(
    side: Side,
    eventName: "loaded-protyle-static" | "loaded-protyle-dynamic",
  ): void {
    const pending = this.pendingSliceSync[side];
    if (pending && Date.now() <= pending.expiresAt) {
      this.scrollSync.suppressEcho(side);
      this.applyPendingSliceAlignment(side, eventName);
      return;
    }
    delete this.pendingSliceSync[side];

    // Guard against follower `CB_GET_BEFORE` / `CB_GET_APPEND` synchronous `scrollTop` compensation
    // echoing a synthetic scroll event back to the active driver side!
    if (this.lastUserScrollSide && this.lastUserScrollSide !== side && Date.now() - this.lastUserScrollAt < 2500) {
      this.scrollSync.suppressEcho(side);
      return;
    }

    // If the user just drove `side` via SiYuan's `.protyle-scroll` slider / Home / End / Page buttons,
    // `loaded-protyle-static` fires on `side` without necessarily changing `side.scrollTop`.
    if (
      eventName === "loaded-protyle-static" &&
      this.scrollSync.isEnabled &&
      this.lastStaticDriverSide === side &&
      Date.now() - this.lastStaticDriverAt < 3000
    ) {
      const mounted = this.inspectMountedDom(side);
      const totalRoots = side === "left" ? this.leftRootBlockIDs.length : this.rightRootBlockIDs.length;
      this.debugLog("scroll-driver-static-load", {
        side,
        mountedRange: `${mounted.minRootIndex}..${mounted.maxRootIndex}/${totalRoots}`,
      });
      this.scrollSync.handleScroll(side);
    }
  }

  private applyPendingSliceAlignment(side: Side, trigger: string): void {
    const pending = this.pendingSliceSync[side];
    if (!pending || Date.now() > pending.expiresAt) {
      delete this.pendingSliceSync[side];
      return;
    }

    const doc = side === "left" ? this.leftDoc : this.rightDoc;
    const wysiwygEl = doc.protyle.wysiwyg.element as HTMLElement;
    const scroller = getScroller(doc);
    const scrollerRect = scroller.getBoundingClientRect();
    const mounted = this.inspectMountedDom(side);
    const totalRoots = side === "left" ? this.leftRootBlockIDs.length : this.rightRootBlockIDs.length;
    let targetEl = this.findMountedTargetElement(mounted, wysiwygEl, pending.targetBlockID, pending.targetRootIndex);

    // If kernel backtracked `setIndex(desiredStartIndex)` because `targetRootIndex` is inside a folded section
    // (`maxRootIndex < lastRequestedStartIndex`), align to the last visible mounted block and finish cleanly.
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
        this.scheduleDisjointSliceJump(
          side,
          pending.targetRootIndex,
          pending.targetBlockID,
          "pending-retry",
          `${mounted.minRootIndex}..${mounted.maxRootIndex}/${totalRoots}`,
          "retry-after-load",
        );
      } else {
        this.debugLog("scroll-slice-align-missed", {
          side,
          trigger,
          targetBlockID: pending.targetBlockID ?? null,
          targetRootIndex: pending.targetRootIndex,
          mountedRange: `${mounted.minRootIndex}..${mounted.maxRootIndex}/${totalRoots}`,
        });
        delete this.pendingSliceSync[side];
      }
      return;
    }

    if (pending.alignMode === "center") {
      doc.protyle?.observerLoad?.disconnect?.();
    }

    const alignToTarget = (): number => {
      const latestScrollerRect = scroller.getBoundingClientRect();
      const targetRect = targetEl.getBoundingClientRect();
      let desiredTop: number;
      if (pending.alignMode === "center") {
        desiredTop =
          scroller.scrollTop +
          (targetRect.top - latestScrollerRect.top) -
          Math.max(24, (latestScrollerRect.height - Math.min(targetRect.height, latestScrollerRect.height)) / 2);
      } else {
        const readingOffset = Math.min(48, Math.max(0, scroller.clientHeight * 0.15));
        const targetContentTop = targetRect.top - latestScrollerRect.top + scroller.scrollTop;
        desiredTop =
          targetContentTop +
          pending.sourceProgress * Math.max(1, targetRect.height) -
          readingOffset;
      }
      const clamped = withinScrollExtent(desiredTop, scroller.scrollHeight, scroller.clientHeight);
      this.scrollSync.applyProgrammaticScroll(side, clamped, pending.fromSide);
      return clamped;
    };

    const appliedTop = alignToTarget();
    this.scheduleOverlayRedraw(true);
    this.debugLog("scroll-slice-aligned", {
      side,
      trigger,
      targetBlockID: pending.targetBlockID ?? null,
      targetRootIndex: pending.targetRootIndex,
      mountedRange: `${mounted.minRootIndex}..${mounted.maxRootIndex}/${totalRoots}`,
      appliedScrollTop: Math.round(appliedTop),
      scrollerHeight: Math.round(scrollerRect.height),
    });

    // Re-verify alignment after SiYuan's `setIndex` `TIMEOUT_INPUT` (256ms) clears `style.overflow = "hidden"`.
    if (this.sliceStabilizeTimers[side] !== undefined) {
      clearTimeout(this.sliceStabilizeTimers[side]);
    }
    this.sliceStabilizeTimers[side] = setTimeout(() => {
      delete this.sliceStabilizeTimers[side];
      if (this.closed || this.pendingSliceSync[side] !== pending) return;
      if (targetEl.isConnected) {
        alignToTarget();
        this.scheduleOverlayRedraw(false);
      }
      delete this.pendingSliceSync[side];
    }, 270);
  }

  private navigate(delta: number): void {
    if (this.closed || this.dirty.pending) return;
    const visible = this.filteredHunks();
    if (visible.length === 0) return;

    if (!this.hasNavigated) {
      this.cursor = delta >= 0 ? 0 : visible.length - 1;
      this.hasNavigated = true;
    } else {
      this.cursor = (this.cursor + delta + visible.length) % visible.length;
    }

    const hunk = visible[this.cursor]!;
    this.focusedHunkKey = hunk.key;
    this.scrollSync.suppressFor(450);
    this.clearPendingSliceTimers();

    this.leftPainter.paint(this.currentDiff, this.leftUnits, this.filter, this.focusedHunkKey);
    this.rightPainter.paint(this.currentDiff, this.rightUnits, this.filter, this.focusedHunkKey);

    for (const side of ["left", "right"] as const) {
      const doc = side === "left" ? this.leftDoc : this.rightDoc;
      const scroller = getScroller(doc);

      if (hunk.kind === "title") {
        this.scrollSync.applyProgrammaticScroll(side, 0, side);
        continue;
      }

      const sideUnits = side === "left" ? hunk.left : hunk.right;
      const ownUnit = sideUnits[0];
      const targetBlockID =
        ownUnit?.blockID ?? findNearestMatchedBlockID(this.currentDiff.matches, hunk, side);
      if (!targetBlockID) continue;

      const rootIndexMap = side === "left" ? this.leftRootIndexByBlockID : this.rightRootIndexByBlockID;
      const targetRootIndex = rootIndexMap.get(targetBlockID) ?? 1;
      const rawMountedBlock = queryLiveBlock(doc, targetBlockID);
      const mountedBlock =
        rawMountedBlock && isBlockRectVisible(rawMountedBlock.getBoundingClientRect())
          ? rawMountedBlock
          : null;
      this.debugLog("navigate-hunk", {
        side,
        cursor: `${this.cursor + 1}/${visible.length}`,
        hunkKey: hunk.key,
        hunkKind: hunk.kind,
        targetBlockID,
        targetRootIndex,
        mounted: Boolean(mountedBlock),
      });

      if (mountedBlock) {
        let focusEl: HTMLElement = mountedBlock;
        if (ownUnit?.tableRowIndex !== undefined) {
          const rows = mountedBlock.querySelectorAll<HTMLElement>("tr:not([data-sy-table-virtual-rows])");
          if (ownUnit.tableRowIndex < rows.length) {
            focusEl = rows[ownUnit.tableRowIndex]!;
          }
        }
        const scrollerRect = scroller.getBoundingClientRect();
        const blockRect = focusEl.getBoundingClientRect();
        const desiredTop =
          scroller.scrollTop +
          (blockRect.top - scrollerRect.top) -
          Math.max(24, (scrollerRect.height - Math.min(blockRect.height, scrollerRect.height)) / 2);
        this.scrollSync.applyProgrammaticScroll(
          side,
          withinScrollExtent(desiredTop, scroller.scrollHeight, scroller.clientHeight),
          side,
        );
      } else {
        // Target block is outside the virtualized DOM window: record pending alignment and load context slice (`mode: 3`).
        this.pendingSliceSync[side] = {
          targetBlockID,
          targetRootIndex,
          sourceProgress: 0,
          alignMode: "center",
          fromSide: side,
          expiresAt: Date.now() + 3500,
          attempts: 1,
        };
        if (doc.tab?.headElement && typeof doc.wndInstance?.switchTab === "function") {
          this.swapping = true;
          try {
            doc.wndInstance.switchTab(doc.tab.headElement, false);
          } finally {
            this.swapping = false;
          }
        }
        void this.cfg.bridge.openDocTab({
          app: this.cfg.plugin.app,
          id: targetBlockID,
          action: ["cb-get-hl", "cb-get-context"],
          removeCurrentTab: false,
        });
      }
    }

    this.pushToolbarState();
  }

  dispose(): void {
    if (this.closed) return;
    this.closed = true;
    this.debugLog("session-disposed", {
      leftID: this.leftDoc.id,
      rightID: this.rightDoc.id,
    });
    if (this.rafHandle !== undefined && typeof cancelAnimationFrame === "function") {
      cancelAnimationFrame(this.rafHandle);
      this.rafHandle = undefined;
    }
    if (this.retryTimer !== undefined) {
      clearTimeout(this.retryTimer);
      this.retryTimer = undefined;
    }
    this.clearPendingSliceTimers();
    this.coordinator.dispose();
    this.mutationObserver?.disconnect();
    this.resizeObserver?.disconnect();
    this.paneCleanups.splice(0).reverse().forEach(off => {
      try { off(); } catch { /* ignore */ }
    });
    this.hostCleanup.splice(0).reverse().forEach(off => {
      try { off(); } catch { /* ignore */ }
    });
    this.scrollSync.dispose();
    this.leftPainter.dispose();
    this.rightPainter.dispose();
    this.toolbar.dispose();
    this.cfg.onClosed();
  }
}
