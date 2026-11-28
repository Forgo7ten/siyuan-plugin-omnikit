import type { ITrackedRangeHandle, ITrackRangeOptions, TTrackedRangeResult } from "siyuan";
import type { FeatureContext } from "../../../core/framework/FeatureContext.ts";
import type { FeatureScope } from "../../../core/framework/FeatureScope.ts";
import type { Logger } from "../../../core/host/Logger.ts";
import { isInsideProtectedContainer } from "../../../core/host/dom.ts";
import {
  flushProtyleTransactions,
  isProtyleReadOnly,
  resolveWysiwygElement,
} from "../../../core/host/ProtyleAdapter.ts";
import {
  alignCollapsedPasteBoundary,
  capturePrePasteBlockAnchor,
  collectCandidateLinksFromBlockAnchor,
  collectCandidateLinksInRange,
  collectPrePasteLinks,
  createRangeFromResolved,
  hasClipboardLinkCandidate,
  isSingleBareURL,
} from "../policy/paste-range.ts";

export const DEFAULT_PASTE_QUIET_MS = 100;
export const DEFAULT_PASTE_DEADLINE_MS = 30_000;
export const BUSY_RECHECK_MS = 500;

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
  isComposing?: (protyle?: unknown) => boolean;
  onLinksCaptured: (links: readonly HTMLElement[], protyle: unknown) => void | Promise<void>;
  logger?: Logger;
  quietMs?: number;
  deadlineMs?: number;
  setTimer?: (handler: () => void, ms: number) => ReturnType<typeof setTimeout>;
  clearTimer?: (id: ReturnType<typeof setTimeout>) => void;
  MutationObserver?: typeof globalThis.MutationObserver;
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

function elementForNode(node: Node | null | undefined): Element | null {
  if (!node) return null;
  return node.nodeType === 1 ? (node as Element) : node.parentElement;
}

function isSelectionProtected(original: Range): boolean {
  const startEl = elementForNode(original.startContainer);
  const endEl = elementForNode(original.endContainer);
  return Boolean(startEl && isInsideProtectedContainer(startEl) && endEl && isInsideProtectedContainer(endEl));
}

function isSelectionReadOnly(protyle: unknown, original: Range): boolean {
  const startEl = elementForNode(original.startContainer);
  const endEl = elementForNode(original.endContainer);
  return isProtyleReadOnly(protyle, startEl) || (endEl !== startEl && isProtyleReadOnly(protyle, endEl));
}

/**
 * Captures pasted link ranges using native capture-phase `paste` events, SiYuan `trackRange`
 * boundary handles, `MutationObserver`, and Core `flushProtyleTransactions`.
 */
export class PasteLinkCapture {
  private readonly attachedEditors = new WeakMap<HTMLElement, EditorBinding>();
  private readonly activeBindings = new Set<EditorBinding>();
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
      protyleOrEditor &&
      typeof (protyleOrEditor as HTMLElement).addEventListener === "function" &&
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
  }

  private handlePaste(
    editor: HTMLElement,
    protyle: unknown,
    event: ClipboardEvent,
    editorCaptures: Set<(reason: string) => void>,
  ): void {
    if (this.disposed || !this.options.isEnabled()) {
      this.options.logger?.debug?.("忽略粘贴事件：捕获器已释放或自动提取未启用", {
        disposed: this.disposed,
        enabled: this.options.isEnabled(),
      });
      return;
    }
    if (isProtyleReadOnly(protyle, editor)) {
      this.options.logger?.debug?.("编辑器处于只读状态，跳过粘贴捕获");
      return;
    }

    const clipboardData = event.clipboardData;
    const textPlain = clipboardData?.getData?.("text/plain") ?? "";
    const textHtml = clipboardData?.getData?.("text/html") ?? "";
    const selection = globalThis.getSelection?.() ?? null;

    // Non-collapsed selection with a single bare URL turns selected text into a link anchor;
    // skip before allocating trackRange handles or MutationObserver even if text/html carries <a>.
    if (selection && !selection.isCollapsed && isSingleBareURL(textPlain)) {
      this.options.logger?.debug?.("非空选区粘贴单条裸 URL，跳过自动抓标题");
      return;
    }
    if (!hasClipboardLinkCandidate(textPlain, textHtml)) {
      this.options.logger?.debug?.("剪贴板不含可提取链接候选，跳过粘贴捕获");
      return;
    }
    if (!selection || selection.rangeCount !== 1) {
      this.options.logger?.debug?.("选区无效或非单一选区，跳过粘贴捕获", {
        hasSelection: Boolean(selection),
        rangeCount: selection?.rangeCount ?? 0,
      });
      return;
    }

    const original = selection.getRangeAt(0).cloneRange();
    if (!editor.contains(original.startContainer) || !editor.contains(original.endContainer)) {
      this.options.logger?.debug?.("选区超出当前编辑器范围，跳过粘贴捕获");
      return;
    }
    if (isSelectionReadOnly(protyle, original)) {
      this.options.logger?.debug?.("选区所在块处于只读状态，跳过粘贴捕获");
      return;
    }
    if (isSelectionProtected(original)) {
      this.options.logger?.debug?.("选区位于受保护容器内，跳过粘贴捕获");
      return;
    }

    const host = resolveTrackableProtyle(protyle);
    if (!host) {
      this.options.logger?.debug?.("Protyle 不支持 trackRange，跳过粘贴捕获");
      return;
    }

    const beforeElements = collectPrePasteLinks(original);
    const boundary = alignCollapsedPasteBoundary(original);
    const blockAnchor = capturePrePasteBlockAnchor(editor, boundary);
    const startBoundary = boundary.cloneRange();
    startBoundary.collapse(true);
    const endBoundary = boundary.cloneRange();
    endBoundary.collapse(false);

    let startHandle: ITrackedRangeHandle | undefined;
    let endHandle: ITrackedRangeHandle | undefined;
    try {
      startHandle = host.trackRange(startBoundary, { owner: this.options.plugin, affinity: "before" });
      endHandle = host.trackRange(endBoundary, { owner: this.options.plugin, affinity: "after" });
    } catch {
      if (startHandle) {
        host.releaseTrackedRange(startHandle);
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
        host.releaseTrackedRange(startHandle);
        startHandle = undefined;
      }
      if (endHandle) {
        host.releaseTrackedRange(endHandle);
        endHandle = undefined;
      }
      editorCaptures.delete(finishCapture);
      releaseScope?.();
      releaseScope = undefined;
      this.options.logger?.debug?.("粘贴范围捕获结束", { reason });
    };

    editorCaptures.add(finishCapture);
    releaseScope = this.options.scope.own(() => finishCapture("scope-disposed"));
    if (finished) return;

    const scheduleQuietCheck = (delay = this.quietMs): void => {
      if (finished) return;
      pendingRecheck = false;
      if (quietTimer !== undefined) this.clearTimer(quietTimer);
      quietTimer = this.setTimer(() => {
        quietTimer = undefined;
        return evaluate();
      }, delay);
    };

    const inspectCurrentLinks = (): HTMLElement[] | undefined => {
      const startResolved = host.resolveTrackedRange(startHandle!);
      const endResolved = host.resolveTrackedRange(endHandle!);
      if (startResolved.status !== "resolved" || endResolved.status !== "resolved") {
        const fallbackLinks = collectCandidateLinksFromBlockAnchor(editor, blockAnchor, beforeElements);
        if (fallbackLinks === null) {
          this.options.logger?.debug?.("trackRange 边界解析未就绪", {
            startStatus: startResolved.status,
            endStatus: endResolved.status,
          });
          finishCapture("invalid-range");
          return undefined;
        }
        if (fallbackLinks.length === 0) {
          finishCapture("no-candidate");
          return undefined;
        }
        return fallbackLinks;
      }
      const range = createRangeFromResolved(editor, startResolved.range, endResolved.range);
      if (!range) {
        finishCapture("empty-range");
        return undefined;
      }
      const links = collectCandidateLinksInRange(range, beforeElements);
      if (links.length === 0) {
        finishCapture("no-candidate");
        return undefined;
      }
      return links;
    };

    const isCaptureActive = (): boolean => this.options.isEnabled() && editor.isConnected !== false;

    const evaluate = async (): Promise<void> => {
      if (finished) return;
      if (evaluating) {
        pendingRecheck = true;
        return;
      }
      evaluating = true;
      try {
        if (!isCaptureActive()) {
          finishCapture("inactive");
          return;
        }
        // 1) 上传或 IME 组合中绝不调 flushPendingTransactions，低频延后复检
        if (isProtyleUploading(protyle) || this.options.isComposing?.(protyle)) {
          this.options.logger?.debug?.("编辑器正在上传或输入法组合中，跳过 flush 并低频延后复检");
          scheduleQuietCheck(BUSY_RECHECK_MS);
          return;
        }
        // 2) 无副作用直检当前范围：无效/空范围或无候选链接立即释放句柄（零 flush）
        if (!inspectCurrentLinks()) return;

        // 3) 仅在非上传、非 IME 且检出候选链接时安全 flush 一次，确认 /api/transactions 落盘后再建立块基线
        await flushProtyleTransactions(protyle);
        if (finished) return;
        if (!isCaptureActive()) {
          finishCapture("inactive");
          return;
        }
        const links = inspectCurrentLinks();
        if (!links) return;
        this.options.logger?.debug?.("粘贴范围捕获到候选链接", { count: links.length });
        finishCapture("captured");
        void this.options.onLinksCaptured(links, protyle);
      } catch (error) {
        this.options.logger?.debug?.("评估粘贴捕获范围异常", { error });
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

    observer = new ObserverCtor(() => {
      scheduleQuietCheck();
    });
    observer.observe(editor, { childList: true, subtree: true, characterData: true });

    deadlineTimer = this.setTimer(() => {
      deadlineTimer = undefined;
      finishCapture("timeout");
    }, this.deadlineMs);
  }
}
