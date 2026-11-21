import type { ITrackedRangeHandle, ITrackRangeOptions, TTrackedRangeResult } from "siyuan";
import type { FeatureContext } from "../../../core/framework/FeatureContext.ts";
import type { FeatureScope } from "../../../core/framework/FeatureScope.ts";
import type { Logger } from "../../../core/host/Logger.ts";
import { isInsideProtectedContainer } from "../../../core/host/dom.ts";
import {
  collectCandidateLinksInRange,
  collectPrePasteLinks,
  createRangeFromResolved,
  hasClipboardLinkCandidate,
  isSingleBareURL,
} from "../policy/paste-range.ts";

export const DEFAULT_PASTE_QUIET_MS = 100;
export const DEFAULT_PASTE_DEADLINE_MS = 30_000;

interface TrackableProtyle {
  trackRange(range: Range, options: ITrackRangeOptions): ITrackedRangeHandle;
  resolveTrackedRange(handle: ITrackedRangeHandle): TTrackedRangeResult;
  releaseTrackedRange(handle: ITrackedRangeHandle): void;
  flushPendingTransactions?: () => Promise<void>;
  isUploading?: () => boolean;
  upload?: { isUploading?: boolean };
  title?: { isUploading?: () => boolean };
  protyle?: TrackableProtyle;
  getInstance?: () => TrackableProtyle | undefined;
}

interface EditorBinding {
  protyle: unknown;
  readonly captures: Set<(reason: string) => void>;
  readonly cleanup: () => void;
}

export interface PasteLinkCaptureOptions {
  plugin: FeatureContext["plugin"];
  scope: FeatureScope;
  isEnabled: () => boolean;
  onLinksCaptured: (links: readonly HTMLElement[], protyle: unknown) => void | Promise<void>;
  logger?: Logger;
  quietMs?: number;
  deadlineMs?: number;
  setTimer?: (handler: () => void, ms: number) => ReturnType<typeof setTimeout>;
  clearTimer?: (id: ReturnType<typeof setTimeout>) => void;
  MutationObserver?: typeof globalThis.MutationObserver;
}

export function resolveWysiwygElement(context: unknown): HTMLElement | undefined {
  if (!context || typeof context !== "object") return undefined;
  const target = (context as { detail?: any }).detail ?? context;
  const element =
    target?.wysiwyg?.element ??
    target?.protyle?.wysiwyg?.element ??
    (typeof target?.getInstance === "function" ? target.getInstance()?.protyle?.wysiwyg?.element : undefined);
  if (!element || typeof element !== "object") return undefined;
  if (typeof element.addEventListener !== "function" || typeof element.contains !== "function") return undefined;
  return element as HTMLElement;
}

function resolveTrackableProtyle(protyle: unknown): TrackableProtyle | undefined {
  if (!protyle || typeof protyle !== "object") return undefined;
  const candidate = protyle as TrackableProtyle;
  if (
    typeof candidate.trackRange === "function" &&
    typeof candidate.resolveTrackedRange === "function" &&
    typeof candidate.releaseTrackedRange === "function"
  ) {
    return candidate;
  }
  if (candidate.protyle && candidate.protyle !== candidate) {
    return resolveTrackableProtyle(candidate.protyle);
  }
  return undefined;
}

async function flushProtyleTransactions(protyle: unknown): Promise<void> {
  const host = protyle as TrackableProtyle | undefined;
  if (!host) return;
  if (typeof host.flushPendingTransactions === "function") {
    await host.flushPendingTransactions();
    return;
  }
  if (typeof host.getInstance === "function") {
    const instance = host.getInstance();
    if (typeof instance?.flushPendingTransactions === "function") {
      await instance.flushPendingTransactions();
    }
  }
}

function isProtyleUploading(protyle: unknown): boolean {
  const host = protyle as TrackableProtyle | undefined;
  if (!host) return false;
  if (typeof host.isUploading === "function" && host.isUploading()) return true;
  if (host.upload?.isUploading || host.title?.isUploading?.()) return true;
  if (host.protyle?.upload?.isUploading || host.protyle?.title?.isUploading?.()) return true;
  if (typeof host.getInstance === "function") {
    const instance = host.getInstance();
    if (typeof instance?.isUploading === "function" && instance.isUploading()) return true;
  }
  return false;
}

function isSelectionProtected(original: Range): boolean {
  const elementFor = (node: Node): Element | null =>
    node.nodeType === 1 ? (node as Element) : node.parentElement;
  const startEl = elementFor(original.startContainer);
  const endEl = elementFor(original.endContainer);
  return Boolean(startEl && isInsideProtectedContainer(startEl) && endEl && isInsideProtectedContainer(endEl));
}

/**
 * Captures pasted link ranges using native capture-phase `paste` events, SiYuan `trackRange`
 * boundary handles, `MutationObserver`, and `flushPendingTransactions()`.
 */
export class PasteLinkCapture {
  private readonly attachedEditors = new WeakMap<HTMLElement, EditorBinding>();
  private readonly activeBindings = new Set<EditorBinding>();
  private readonly pendingCaptures = new Set<(reason: string) => void>();
  private readonly quietMs: number;
  private readonly deadlineMs: number;
  private readonly setTimer: (handler: () => void, ms: number) => ReturnType<typeof setTimeout>;
  private readonly clearTimer: (id: ReturnType<typeof setTimeout>) => void;
  private disposed = false;

  constructor(private readonly options: PasteLinkCaptureOptions) {
    this.quietMs = options.quietMs ?? DEFAULT_PASTE_QUIET_MS;
    this.deadlineMs = options.deadlineMs ?? DEFAULT_PASTE_DEADLINE_MS;
    this.setTimer = options.setTimer ?? ((handler, ms) => setTimeout(handler, ms));
    this.clearTimer = options.clearTimer ?? ((id) => clearTimeout(id));
  }

  attach(protyle: unknown): void {
    if (this.disposed) return;
    const editor = resolveWysiwygElement(protyle);
    if (!editor) return;
    const existing = this.attachedEditors.get(editor);
    if (existing) {
      existing.protyle = protyle;
      return;
    }

    const captures = new Set<(reason: string) => void>();
    const onPaste = (event: ClipboardEvent) => {
      this.handlePaste(editor, binding.protyle, event, captures);
    };
    editor.addEventListener("paste", onPaste, { capture: true });

    const binding: EditorBinding = {
      protyle,
      captures,
      cleanup: () => {
        editor.removeEventListener("paste", onPaste, { capture: true });
        this.attachedEditors.delete(editor);
        this.activeBindings.delete(binding);
        for (const finish of [...captures]) {
          finish("editor-destroyed");
        }
      },
    };
    this.attachedEditors.set(editor, binding);
    this.activeBindings.add(binding);
  }

  detach(protyleOrEditor: unknown): void {
    const editor =
      protyleOrEditor && typeof (protyleOrEditor as HTMLElement).addEventListener === "function" &&
      this.attachedEditors.has(protyleOrEditor as HTMLElement)
        ? (protyleOrEditor as HTMLElement)
        : resolveWysiwygElement(protyleOrEditor);
    if (!editor) return;
    this.attachedEditors.get(editor)?.cleanup();
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const binding of [...this.activeBindings]) {
      binding.cleanup();
    }
    for (const finish of [...this.pendingCaptures]) {
      finish("disposed");
    }
  }

  private handlePaste(
    editor: HTMLElement,
    protyle: unknown,
    event: ClipboardEvent,
    editorCaptures: Set<(reason: string) => void>,
  ): void {
    if (this.disposed || !this.options.isEnabled()) return;

    const clipboardData = event.clipboardData;
    const textPlain = clipboardData?.getData?.("text/plain") ?? "";
    const textHtml = clipboardData?.getData?.("text/html") ?? "";
    const selection = globalThis.getSelection?.() ?? null;

    // Non-collapsed selection with a single bare URL turns selected text into a link anchor;
    // skip before allocating trackRange handles or MutationObserver even if text/html carries <a>.
    if (selection && !selection.isCollapsed && isSingleBareURL(textPlain)) {
      return;
    }
    if (!hasClipboardLinkCandidate(textPlain, textHtml)) {
      return;
    }
    if (!selection || selection.rangeCount !== 1) return;

    const original = selection.getRangeAt(0).cloneRange();
    if (!editor.contains(original.startContainer) || !editor.contains(original.endContainer)) return;
    if (isSelectionProtected(original)) return;

    const host = resolveTrackableProtyle(protyle);
    if (!host) return;

    const beforeElements = collectPrePasteLinks(original);
    const startBoundary = original.cloneRange();
    startBoundary.collapse(true);
    const endBoundary = original.cloneRange();
    endBoundary.collapse(false);

    let startHandle: ITrackedRangeHandle | undefined;
    let endHandle: ITrackedRangeHandle | undefined;
    try {
      startHandle = host.trackRange(startBoundary, { owner: this.options.plugin, affinity: "before" });
      endHandle = host.trackRange(endBoundary, { owner: this.options.plugin, affinity: "after" });
    } catch {
      if (startHandle) {
        try { host.releaseTrackedRange(startHandle); } catch {}
      }
      if (endHandle) {
        try { host.releaseTrackedRange(endHandle); } catch {}
      }
      return;
    }

    let finished = false;
    let evaluating = false;
    let pendingRecheck = false;
    let quietTimer: ReturnType<typeof setTimeout> | undefined;
    let deadlineTimer: ReturnType<typeof setTimeout> | undefined;
    let observer: MutationObserver | undefined;
    let releaseScope: (() => void) | undefined;

    const finishCapture = (reason: string): void => {
      if (finished) return;
      finished = true;
      if (quietTimer !== undefined) {
        this.clearTimer(quietTimer);
        quietTimer = undefined;
      }
      if (deadlineTimer !== undefined) {
        this.clearTimer(deadlineTimer);
        deadlineTimer = undefined;
      }
      observer?.disconnect();
      observer = undefined;
      if (startHandle) {
        try { host.releaseTrackedRange(startHandle); } catch {}
        startHandle = undefined;
      }
      if (endHandle) {
        try { host.releaseTrackedRange(endHandle); } catch {}
        endHandle = undefined;
      }
      this.pendingCaptures.delete(finishCapture);
      editorCaptures.delete(finishCapture);
      releaseScope?.();
      releaseScope = undefined;
      this.options.logger?.debug?.("粘贴范围捕获结束", { reason });
    };

    this.pendingCaptures.add(finishCapture);
    editorCaptures.add(finishCapture);
    releaseScope = this.options.scope.own(() => finishCapture("scope-disposed"));
    if (finished) return;

    const scheduleQuietCheck = (): void => {
      if (finished) return;
      if (quietTimer !== undefined) this.clearTimer(quietTimer);
      quietTimer = this.setTimer(() => {
        quietTimer = undefined;
        return evaluate();
      }, this.quietMs);
    };

    const evaluate = async (): Promise<void> => {
      if (finished) return;
      if (evaluating) {
        pendingRecheck = true;
        return;
      }
      evaluating = true;
      try {
        await flushProtyleTransactions(protyle);
        if (finished) return;
        if (!this.options.isEnabled() || editor.isConnected === false) {
          finishCapture("inactive");
          return;
        }
        if (!startHandle || !endHandle) {
          finishCapture("missing-handle");
          return;
        }
        const startResolved = host.resolveTrackedRange(startHandle);
        const endResolved = host.resolveTrackedRange(endHandle);
        if (startResolved.status !== "resolved" || endResolved.status !== "resolved") {
          finishCapture("invalid-range");
          return;
        }
        const range = createRangeFromResolved(editor, startResolved.range, endResolved.range);
        if (!range) {
          return;
        }
        const links = collectCandidateLinksInRange(range, beforeElements);
        if (links.length > 0) {
          finishCapture("captured");
          void this.options.onLinksCaptured(links, protyle);
          return;
        }
        if (!isProtyleUploading(protyle)) {
          finishCapture("no-candidate");
          return;
        }
        scheduleQuietCheck();
      } catch {
        finishCapture("error");
      } finally {
        evaluating = false;
        if (!finished && pendingRecheck) {
          pendingRecheck = false;
          scheduleQuietCheck();
        }
      }
    };

    const ObserverCtor = this.options.MutationObserver ?? globalThis.MutationObserver;
    if (typeof ObserverCtor !== "function") {
      finishCapture("no-observer");
      return;
    }

    try {
      observer = new ObserverCtor(() => {
        scheduleQuietCheck();
      });
      observer.observe(editor, { childList: true, subtree: true, characterData: true });
    } catch {
      finishCapture("observer-failed");
      return;
    }

    deadlineTimer = this.setTimer(() => {
      deadlineTimer = undefined;
      finishCapture("timeout");
    }, this.deadlineMs);
  }
}
