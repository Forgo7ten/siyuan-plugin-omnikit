import type { App, Plugin } from "siyuan";
import { describeError } from "../../../core/host/describeError.ts";
import type { KernelClient } from "../../../core/host/KernelClient.ts";
import { Logger } from "../../../core/host/Logger.ts";
import type { HostBridge } from "../host/SiyuanBridge.ts";
import { applyComparableTitleHunk } from "../model/conflict.ts";
import { alignUnits, retainHunkCursor } from "../model/DiffEngine.ts";
import {
  buildToolbarViewState,
  type ToolbarActions,
  type ToolbarFactory,
  type ToolbarHandle,
  type ToolbarViewState,
} from "../model/toolbarState.ts";
import {
  EMPTY_DIFF_RESULT,
  matchesDiffFilter,
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
import { getScroller } from "./mountedDomIndex.ts";
import { bindProtyleScrollGestures, ScrollSync } from "./ScrollSync.ts";
import { ViewportSliceSync, type ViewportSliceSyncHost } from "./ViewportSliceSync.ts";
import { canSwapVisiblePair, findVisiblePair, swapVisiblePair, type VisibleDoc } from "./VisiblePair.ts";
import { verifyVisibleParity } from "./VisibleParity.ts";
import { classifyWsMainDiffEvent, type ComparableDocRef } from "./wsMainFilter.ts";

export type { ToolbarActions, ToolbarFactory, ToolbarHandle, ToolbarViewState };

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
  onDestroyedByProtyle?: (left: ComparableDocRef, right: ComparableDocRef) => void;
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

const MAX_PARITY_RETRIES = 4;
const PARITY_RETRY_DELAY_MS = 450;

/**
 * Owns one active side-by-side comparison session: coordinates snapshots, parity checks,
 * non-invasive painting, filter chips, cross-viewport jump navigation, scroll sync, and pane swap.
 */
export class DocumentDiffSession implements ViewportSliceSyncHost {
  leftDoc: VisibleDoc;
  rightDoc: VisibleDoc;
  readonly scrollSync: ScrollSync;
  leftUnits: SemanticUnit[] = [];
  rightUnits: SemanticUnit[] = [];
  leftRootIndexByBlockID = new Map<string, number>();
  rightRootIndexByBlockID = new Map<string, number>();
  leftRootBlockIDs: string[] = [];
  rightRootBlockIDs: string[] = [];
  closed = false;

  private leftIdentity: DocumentIdentityLabel;
  private rightIdentity: DocumentIdentityLabel;
  private readonly logger: Logger;
  private readonly dirty = new DirtyGate();
  private readonly leftPainter: DiffPainter;
  private readonly rightPainter: DiffPainter;
  private readonly sliceSync: ViewportSliceSync;
  private readonly coordinator: ComputeCoordinator<ComputedSnapshotResult>;
  private readonly toolbar: ToolbarHandle;
  private readonly hostCleanup: Array<() => void> = [];
  private paneCleanups: Array<() => void> = [];
  private mutationObserver?: MutationObserver;
  private visibilityObserver?: MutationObserver;
  private resizeObserver?: ResizeObserver;
  private rafHandle?: number;
  private retryTimer?: ReturnType<typeof setTimeout>;
  private readonly debugThrottleAt = new Map<string, number>();
  private parityRetries = 0;

  private currentDiff: DiffResult = EMPTY_DIFF_RESULT;
  private filter: DiffFilter = "all";
  private cursor = 0;
  private focusedHunkKey?: string;
  private hasNavigated = false;
  private userSyncEnabled: boolean;
  private statusKind: SessionStatusKind = "comparing";
  private errorReason = "";
  private swapping = false;

  get app(): App { return this.cfg.plugin.app; }
  get bridge(): HostBridge { return this.cfg.bridge; }
  get pending(): boolean { return this.dirty.pending; }
  get diff(): DiffResult { return this.currentDiff; }

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
    this.sliceSync = new ViewportSliceSync(this);

    this.scrollSync = new ScrollSync(
      getScroller(this.leftDoc),
      getScroller(this.rightDoc),
      () => this.sliceSync.computeScrollAnchors(),
      () => performance.now(),
      {
        bindGestureListeners: false,
        shouldSuppressSync: () => this.sliceSync.hasActiveNavigationPending(),
        onUnmappedScroll: (fromSide, readingContentY, own, other, anchorCount) =>
          this.sliceSync.handleUnmappedScroll(fromSide, readingContentY, own, other, anchorCount),
        onBeforeApplyScroll: (targetSide, targetScrollTop, previousScrollTop, sourceSide) =>
          this.sliceSync.prepareTargetProtyleScroll(targetSide, targetScrollTop, previousScrollTop, sourceSide),
        onDebug: (stage, detail, throttleKey) => this.debugLog(stage, detail, throttleKey),
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
    this.visibilityObserver?.disconnect();
    this.resizeObserver?.disconnect();

    const addListener = (target: EventTarget, type: string, handler: EventListener, options?: AddEventListenerOptions) => {
      target.addEventListener(type, handler, options);
      this.paneCleanups.push(() => target.removeEventListener(type, handler, options));
    };

    for (const side of ["left", "right"] as const) {
      const doc = side === "left" ? this.leftDoc : this.rightDoc;
      const protyleEl = doc.protyle.element as HTMLElement;
      const scroller = getScroller(doc);

      addListener(protyleEl, "compositionstart", () => this.coordinator.compositionStart(side), { capture: true });
      addListener(protyleEl, "compositionend", () => {
        this.markLocalEdit(side);
        this.coordinator.compositionEnd(side);
      }, { capture: true });

      for (const editEvent of ["input", "cut", "paste", "drop"] as const) {
        addListener(protyleEl, editEvent, (event: Event) => {
          const target = event.target;
          const isEditableTarget =
            !target ||
            !(typeof Node !== "undefined" && target instanceof Node) ||
            doc.protyle.wysiwyg.element.contains(target) ||
            Boolean(doc.protyle.title?.element?.contains(target));
          if (isEditableTarget) this.markLocalEdit(side);
        }, { capture: true });
      }
      addListener(scroller, "scroll", () => this.scheduleOverlayRedraw(false), { passive: true });
      this.paneCleanups.push(
        bindProtyleScrollGestures(protyleEl, side, (s, trigger, isStatic) =>
          this.sliceSync.recordUserScrollIntent(s, trigger, isStatic),
        ),
      );
    }

    if (typeof MutationObserver !== "undefined") {
      this.mutationObserver = new MutationObserver(() => {
        if (this.closed || this.dirty.pending || this.statusKind === "comparing") return;
        this.scheduleOverlayRedraw(true);
      });
      this.mutationObserver.observe(this.leftDoc.protyle.wysiwyg.element, { childList: true, subtree: true });
      this.mutationObserver.observe(this.rightDoc.protyle.wysiwyg.element, { childList: true, subtree: true });

      this.visibilityObserver = new MutationObserver(() => {
        if (!this.closed && !this.swapping && !this.isPairStillLive()) {
          this.disposeByPairLoss();
        }
      });
      for (const doc of [this.leftDoc, this.rightDoc]) {
        for (const target of [
          doc.panel,
          doc.tab?.headElement as HTMLElement | undefined,
          doc.protyle.contentElement as HTMLElement | undefined,
          doc.protyle.element as HTMLElement | undefined,
        ]) {
          if (target && typeof (target as Node).nodeType === "number") {
            this.visibilityObserver.observe(target, { attributes: true, attributeFilter: ["class"] });
          }
        }
      }
    }

    if (typeof ResizeObserver !== "undefined") {
      this.resizeObserver = new ResizeObserver(() => {
        if (!this.closed) this.scheduleOverlayRedraw(false);
      });
      this.resizeObserver.observe(this.leftDoc.protyle.element);
      this.resizeObserver.observe(this.rightDoc.protyle.element);
    }
  }

  private resolveEventSide(event: CustomEvent<any>): Side | undefined {
    const el = event.detail?.protyle?.element;
    if (el === this.leftDoc.protyle.element) return "left";
    if (el === this.rightDoc.protyle.element) return "right";
    return undefined;
  }

  private bindHostEvents(): void {
    const onWsMain = (event: CustomEvent<any>) => {
      if (this.closed) return;
      const action = classifyWsMainDiffEvent(
        event.detail,
        this.leftDoc,
        this.rightDoc,
        this.leftRootIndexByBlockID,
        this.rightRootIndexByBlockID,
      );
      if (action === "ignore") return;
      if (action === "doc-removed") {
        this.cfg.notify(this.cfg.t("diff.notice.docRemoved"), "error");
        this.dispose();
        return;
      }
      if (action === "transactions") {
        if (this.dirty.pending && this.coordinator.isScheduledOrRunning) {
          return;
        }
        this.requestCompute(!this.dirty.pending);
        return;
      }
      this.requestCompute(false);
    };

    const onDynamicLoad = (event: CustomEvent<any>) => {
      if (this.closed) return;
      const side = this.resolveEventSide(event);
      if (!side) return;
      if (!this.dirty.pending) this.scheduleOverlayRedraw(true);
      this.sliceSync.handleProtyleSliceLoaded(side, "loaded-protyle-dynamic");
    };

    const onStaticLoad = (event: CustomEvent<any>) => {
      if (this.closed) return;
      const side = this.resolveEventSide(event);
      if (!side) return;
      if (!this.isPairStillLive()) {
        this.disposeByPairLoss();
        return;
      }
      if (this.dirty.pending || this.statusKind === "comparing" || this.statusKind === "failed") {
        this.requestCompute(false);
        return;
      }
      this.scheduleOverlayRedraw(true);
      this.sliceSync.handleProtyleSliceLoaded(side, "loaded-protyle-static");
    };

    const onSwitchProtyle = () => {
      if (!this.closed && !this.swapping && !this.isPairStillLive()) this.disposeByPairLoss();
    };
    const onSyncEnd = () => {
      if (!this.closed) this.requestCompute(false);
    };
    const onDestroyProtyle = (event: CustomEvent<any>) => {
      if (!this.closed && this.resolveEventSide(event)) {
        this.disposeByPairLoss();
      }
    };

    const bus = this.cfg.plugin.eventBus;
    const entries: Array<[string, (e: any) => void]> = [
      ["ws-main", onWsMain],
      ["loaded-protyle-dynamic", onDynamicLoad],
      ["loaded-protyle-static", onStaticLoad],
      ["switch-protyle", onSwitchProtyle],
      ["switch-protyle-mode", onSwitchProtyle],
      ["sync-end", onSyncEnd],
      ["destroy-protyle", onDestroyProtyle],
    ];
    for (const [evt, fn] of entries) {
      bus.on(evt as any, fn);
      this.hostCleanup.push(() => bus.off(evt as any, fn));
    }
  }

  scheduleOverlayRedraw(rebindRanges: boolean): void {
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
    return Boolean(
      pair &&
        pair[0].id === this.leftDoc.id &&
        pair[1].id === this.rightDoc.id &&
        pair[0].protyle === this.leftDoc.protyle &&
        pair[1].protyle === this.rightDoc.protyle,
    );
  }

  private filteredHunks(): DiffHunk[] {
    return this.currentDiff.hunks.filter(hunk => matchesDiffFilter(hunk, this.filter));
  }

  private buildToolbarState(): ToolbarViewState {
    const visibleHunks = this.filteredHunks();
    return buildToolbarViewState({
      statusKind: this.statusKind,
      errorReason: this.errorReason,
      pending: this.dirty.pending,
      leftDoc: this.leftIdentity,
      rightDoc: this.rightIdentity,
      counts: this.currentDiff.counts,
      filter: this.filter,
      filteredTotal: visibleHunks.length,
      hasNavigated: this.hasNavigated,
      cursor: this.cursor,
      syncEnabled: this.userSyncEnabled,
      canSwap: canSwapVisiblePair(this.leftDoc, this.rightDoc),
      t: this.cfg.t,
    });
  }

  private pushToolbarState(): void {
    if (!this.closed) this.toolbar.update(this.buildToolbarState());
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
    if (!this.isPairStillLive()) throw new Error(this.cfg.t("diff.error.pairChanged"));
    const capturedGate = this.dirty.capture();
    const reader = new KernelSnapshot(this.cfg.kernel, signal);
    const [leftSnap, rightSnap] = await Promise.all([
      reader.readSnapshot(this.leftDoc.id, this.leftDoc.notebook, this.leftDoc.protyle),
      reader.readSnapshot(this.rightDoc.id, this.rightDoc.notebook, this.rightDoc.protyle),
    ]);
    if (signal.aborted) throw new DOMException("Aborted", "AbortError");

    const forceAcknowledge = this.parityRetries >= MAX_PARITY_RETRIES;
    const leftVerified = !this.dirty.isSidePending("left") || verifyVisibleParity(this.leftDoc.protyle, leftSnap);
    const rightVerified = !this.dirty.isSidePending("right") || verifyVisibleParity(this.rightDoc.protyle, rightSnap);
    this.dirty.acknowledge("left", capturedGate.left, leftVerified || forceAcknowledge);
    this.dirty.acknowledge("right", capturedGate.right, rightVerified || forceAcknowledge);

    const diff = alignUnits(leftSnap.units, rightSnap.units);
    applyComparableTitleHunk(diff, leftSnap, rightSnap, this.cfg.confirmedConflictID);

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

    if (this.filteredHunks().length === 0 && this.filter !== "all" && this.currentDiff.hunks.length > 0) {
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

    this.statusKind = this.currentDiff.unresolved
      ? "unresolved"
      : this.currentDiff.hunks.length > 0
        ? "diff"
        : "equal";

    this.leftPainter.paint(this.currentDiff, this.leftUnits, this.filter, this.focusedHunkKey);
    this.rightPainter.paint(this.currentDiff, this.rightUnits, this.filter, this.focusedHunkKey);
    this.scrollSync.setEnabled(this.userSyncEnabled);
    this.pushToolbarState();

    if (this.logger.isDebugEnabled) {
      const leftMounted = this.sliceSync.inspectMountedDom("left");
      const rightMounted = this.sliceSync.inspectMountedDom("right");
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
    if (this.filteredHunks().length > 0) this.navigate(1);
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
    this.sliceSync.clearTimers();
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
    this.debugLog("swap-left-right", { leftID: this.leftDoc.id, rightID: this.rightDoc.id });
    this.requestCompute(true);
  }

  debugLog(stage: string, detail: Record<string, unknown>, throttleKey?: string, throttleMs = 220): void {
    if (!this.logger.isDebugEnabled) return;
    if (throttleKey) {
      const now = Date.now();
      if (now - (this.debugThrottleAt.get(throttleKey) ?? 0) < throttleMs) return;
      this.debugThrottleAt.set(throttleKey, now);
    }
    this.logger.debug(`[document-diff] ${stage}`, detail);
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
    this.sliceSync.clearTimers();

    this.leftPainter.paint(this.currentDiff, this.leftUnits, this.filter, this.focusedHunkKey);
    this.rightPainter.paint(this.currentDiff, this.rightUnits, this.filter, this.focusedHunkKey);

    const cursorLabel = `${this.cursor + 1}/${visible.length}`;
    this.sliceSync.navigateSideToTargetBlock("left", hunk, cursorLabel);
    this.sliceSync.navigateSideToTargetBlock("right", hunk, cursorLabel);
    this.pushToolbarState();
  }

  private disposeByPairLoss(): void {
    if (this.closed) return;
    this.cfg.onDestroyedByProtyle?.(
      { id: this.leftDoc.id, notebook: this.leftDoc.notebook },
      { id: this.rightDoc.id, notebook: this.rightDoc.notebook },
    );
    this.dispose();
  }

  dispose(): void {
    if (this.closed) return;
    this.closed = true;
    this.debugLog("session-disposed", { leftID: this.leftDoc.id, rightID: this.rightDoc.id });
    if (this.rafHandle !== undefined && typeof cancelAnimationFrame === "function") {
      cancelAnimationFrame(this.rafHandle);
      this.rafHandle = undefined;
    }
    if (this.retryTimer !== undefined) {
      clearTimeout(this.retryTimer);
      this.retryTimer = undefined;
    }
    this.sliceSync.clearTimers();
    this.coordinator.dispose();
    this.mutationObserver?.disconnect();
    this.visibilityObserver?.disconnect();
    this.resizeObserver?.disconnect();
    for (const off of this.paneCleanups.splice(0).reverse()) off();
    for (const off of this.hostCleanup.splice(0).reverse()) off();
    this.scrollSync.dispose();
    this.leftPainter.dispose();
    this.rightPainter.dispose();
    this.toolbar.dispose();
    this.cfg.onClosed();
  }
}
