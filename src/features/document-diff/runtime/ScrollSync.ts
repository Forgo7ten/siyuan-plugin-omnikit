import { linkedY, withinScrollExtent, type ScrollAnchor } from "../model/anchors.ts";
import type { Side } from "../model/types.ts";

export interface ScrollerLike {
  scrollTop: number;
  scrollHeight: number;
  clientHeight: number;
  addEventListener(type: string, callback: EventListener, options?: AddEventListenerOptions): void;
  removeEventListener(type: string, callback: EventListener): void;
}

export interface ScrollSyncCallbacks {
  /**
   * Invoked when in-DOM `ScrollAnchor` interpolation returns `null` (for example, when
   * the two virtualized long-document panes have disjoint loaded block windows or the
   * reading line is beyond the mounted anchor chain).
   * Returning a finite content-Y coordinate scrolls the opposite pane immediately;
   * returning `null` delegates to async cross-slice loading.
   */
  onUnmappedScroll?: (
    fromSide: Side,
    readingContentY: number,
    own: ScrollerLike,
    other: ScrollerLike,
    anchorCount: number,
  ) => number | null;

  /**
   * Invoked right before assigning `other.scrollTop = target` so the caller can synchronize
   * SiYuan's `protyle.scroll.lastScrollTop` or adjust boundary values for dynamic block loading.
   */
  onBeforeApplyScroll?: (
    targetSide: Side,
    targetScrollTop: number,
    previousScrollTop: number,
    sourceSide: Side,
  ) => number | void;

  /**
   * Optional predicate returning `true` when cross-pane scroll echoing must be suppressed
   * (for example, while cross-slice centered hunk navigation is still settling).
   */
  shouldSuppressSync?: (fromSide: Side) => boolean;

  /**
   * Whether `ScrollSync` should attach its own bubble-phase gesture listeners (`wheel`, `touchstart`,
   * `pointerdown`, `keydown`) on scrollers. Defaults to `true`; `DocumentDiffSession` passes `false`
   * because it already binds capture-phase `bindProtyleScrollGestures` on `.protyle` roots.
   */
  bindGestureListeners?: boolean;

  /**
   * Optional structured diagnostic callback for scroll synchronization events.
   */
  onDebug?: (stage: string, detail: Record<string, unknown>, throttleKey?: string) => void;
}

interface ExpectedProgrammaticScroll {
  top: number;
  gesture: number;
  expiresAt: number;
}

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

/**
 * Registers capture-phase user scroll/slider gesture listeners on a `.protyle` root element
 * (including `.protyle-scroll` slider and page buttons that stop propagation in bubble phase).
 */
export function bindProtyleScrollGestures(
  protyleEl: HTMLElement,
  side: Side,
  onIntent: (side: Side, trigger: string, isStaticSliceTrigger: boolean) => void,
): () => void {
  const cleanups: Array<() => void> = [];
  const add = (type: string, handler: EventListener, options?: AddEventListenerOptions) => {
    protyleEl.addEventListener(type, handler, options);
    cleanups.push(() => protyleEl.removeEventListener(type, handler, options));
  };

  for (const gestureEvent of ["wheel", "touchstart", "pointerdown"] as const) {
    add(
      gestureEvent,
      (event: Event) => {
        const target = event.target as HTMLElement | null;
        onIntent(side, gestureEvent, Boolean(target?.closest?.(".protyle-scroll")));
      },
      { capture: true, passive: true },
    );
  }
  add(
    "keydown",
    (event: Event) => {
      const key = (event as KeyboardEvent).key;
      if (typeof key === "string" && SCROLL_INTENT_KEYS.has(key)) {
        onIntent(side, `keydown:${key}`, STATIC_SLICE_NAV_KEYS.has(key));
      }
    },
    { capture: true, passive: true },
  );
  for (const sliderEvent of ["input", "change"] as const) {
    add(
      sliderEvent,
      (event: Event) => {
        const target = event.target as HTMLElement | null;
        if (target?.classList?.contains("b3-slider")) {
          onIntent(side, `slider-${sliderEvent}`, true);
        }
      },
      { capture: true },
    );
  }
  add(
    "click",
    (event: Event) => {
      const target = event.target as HTMLElement | null;
      if (target?.closest?.(".protyle-scroll")) {
        onIntent(side, "protyle-scroll-click", true);
      }
    },
    { capture: true },
  );

  return () => {
    for (let i = cleanups.length - 1; i >= 0; i--) cleanups[i]!();
  };
}

/**
 * Bidirectional content-anchored scroll synchronization with target-offset tolerance,
 * immediate user-gesture preemption, and cross-slice fallback hooks for virtualized long documents.
 */
export class ScrollSync {
  private readonly expected: Partial<Record<Side, ExpectedProgrammaticScroll>> = {};
  private readonly gesture: Record<Side, number> = { left: 0, right: 0 };
  private readonly listeners: Array<() => void> = [];
  private active = true;
  private enabled = true;
  private suspendedUntil = 0;

  constructor(
    private left: ScrollerLike,
    private right: ScrollerLike,
    private readonly getAnchors: () => readonly ScrollAnchor[],
    private readonly now: () => number = () => performance.now(),
    private readonly callbacks: ScrollSyncCallbacks = {},
  ) {
    this.bindSide("left", left);
    this.bindSide("right", right);
  }

  private bindSide(side: Side, element: ScrollerLike): void {
    if (this.callbacks.bindGestureListeners !== false) {
      const onIntent: EventListener = (event: Event) => {
        if (event.type === "keydown") {
          const key = (event as KeyboardEvent).key;
          if (typeof key === "string" && !SCROLL_INTENT_KEYS.has(key)) {
            return;
          }
        }
        this.notifyUserIntent(side);
      };
      for (const eventName of ["wheel", "touchstart", "pointerdown", "keydown"]) {
        element.addEventListener(eventName, onIntent, { passive: true });
        this.listeners.push(() => element.removeEventListener(eventName, onIntent));
      }
    }
    const onScroll: EventListener = () => {
      this.handleScroll(side);
    };
    element.addEventListener("scroll", onScroll, { passive: true });
    this.listeners.push(() => element.removeEventListener("scroll", onScroll));
  }

  /**
   * Marks `side` as actively driven by user interaction, clearing any pending programmatic echo guard.
   */
  notifyUserIntent(side: Side): void {
    ++this.gesture[side];
    delete this.expected[side];
  }

  /**
   * Guards `targetSide` against echoing an upcoming host-induced `scroll` event
   * (such as SiYuan's `onGet` adjusting `scrollTop` during dynamic block prepend/trim).
   */
  suppressEcho(targetSide: Side, durationMs = 360): void {
    if (!this.active) return;
    const scroller = targetSide === "left" ? this.left : this.right;
    this.expected[targetSide] = {
      top: scroller.scrollTop,
      gesture: this.gesture[targetSide],
      expiresAt: this.now() + durationMs,
    };
  }

  rebindScrollers(nextLeft: ScrollerLike, nextRight: ScrollerLike): void {
    if (!this.active) return;
    this.listeners.splice(0).forEach(off => off());
    this.expected.left = undefined;
    this.expected.right = undefined;
    this.left = nextLeft;
    this.right = nextRight;
    this.bindSide("left", nextLeft);
    this.bindSide("right", nextRight);
  }

  setEnabled(on: boolean): void {
    this.enabled = on;
    this.expected.left = undefined;
    this.expected.right = undefined;
  }

  get isEnabled(): boolean {
    return this.enabled;
  }

  /** Suppresses reactive sync briefly during explicit jump navigation. */
  suppressFor(durationMs: number): void {
    this.suspendedUntil = Math.max(this.suspendedUntil, this.now() + durationMs);
    this.expected.left = undefined;
    this.expected.right = undefined;
  }

  /**
   * Applies a programmatic scroll offset to `targetSide` while registering the expected
   * position so the resulting `scroll` event on `targetSide` does not echo back.
   */
  applyProgrammaticScroll(targetSide: Side, desiredScrollTop: number, sourceSide?: Side): boolean {
    if (!this.active) return false;
    const scroller = targetSide === "left" ? this.left : this.right;
    let target = withinScrollExtent(
      desiredScrollTop,
      scroller.scrollHeight,
      scroller.clientHeight,
    );
    const originSide: Side = sourceSide ?? (targetSide === "left" ? "right" : "left");
    const adjusted = this.callbacks.onBeforeApplyScroll?.(
      targetSide,
      target,
      scroller.scrollTop,
      originSide,
    );
    if (typeof adjusted === "number" && Number.isFinite(adjusted)) {
      target = withinScrollExtent(adjusted, scroller.scrollHeight, scroller.clientHeight);
    }
    this.expected[targetSide] = {
      top: target,
      gesture: this.gesture[targetSide],
      expiresAt: this.now() + 360,
    };
    if (Math.abs(target - scroller.scrollTop) < 1) return false;

    scroller.scrollTop = target;
    return true;
  }

  handleScroll(side: Side): boolean {
    if (!this.active || !this.enabled) return false;
    const currentTime = this.now();
    if (currentTime < this.suspendedUntil) return false;
    if (this.callbacks.shouldSuppressSync?.(side)) return false;

    const own = side === "left" ? this.left : this.right;
    const other = side === "left" ? this.right : this.left;
    const opposite: Side = side === "left" ? "right" : "left";

    const expected = this.expected[side];
    if (
      expected &&
      currentTime <= expected.expiresAt &&
      expected.gesture === this.gesture[side] &&
      Math.abs(own.scrollTop - expected.top) < 3
    ) {
      delete this.expected[side];
      return false;
    }
    delete this.expected[side];

    const anchors = this.getAnchors();
    const readingOffset = Math.min(48, Math.max(0, own.clientHeight * 0.15));
    const readingContentY = own.scrollTop + readingOffset;
    let mappedAnchorY = anchors.length > 0 ? linkedY(readingContentY, anchors, side) : null;
    let usedFallback = false;

    if (mappedAnchorY === null && this.callbacks.onUnmappedScroll) {
      mappedAnchorY = this.callbacks.onUnmappedScroll(
        side,
        readingContentY,
        own,
        other,
        anchors.length,
      );
      usedFallback = mappedAnchorY !== null;
    }

    if (mappedAnchorY === null) return false;

    const otherReadingOffset = Math.min(48, Math.max(0, other.clientHeight * 0.15));
    let target = withinScrollExtent(
      mappedAnchorY - otherReadingOffset,
      other.scrollHeight,
      other.clientHeight,
    );
    const adjusted = this.callbacks.onBeforeApplyScroll?.(
      opposite,
      target,
      other.scrollTop,
      side,
    );
    if (typeof adjusted === "number" && Number.isFinite(adjusted)) {
      target = withinScrollExtent(adjusted, other.scrollHeight, other.clientHeight);
    }
    if (Math.abs(target - other.scrollTop) < 2) return false;

    this.expected[opposite] = {
      top: target,
      gesture: this.gesture[opposite],
      expiresAt: currentTime + 360,
    };
    other.scrollTop = target;
    this.callbacks.onDebug?.(
      usedFallback ? "scroll-sync-fallback" : "scroll-sync-anchor",
      {
        from: side,
        to: opposite,
        ownScrollTop: Math.round(own.scrollTop),
        targetScrollTop: Math.round(target),
        anchorCount: anchors.length,
      },
      `sync:${side}:${usedFallback ? "fb" : "anc"}`,
    );
    return true;
  }

  dispose(): void {
    if (!this.active) return;
    this.active = false;
    this.listeners.splice(0).forEach(off => off());
    delete this.expected.left;
    delete this.expected.right;
  }
}
