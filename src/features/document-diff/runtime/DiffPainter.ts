import { createRuntimeId } from "../../../core/host/id.ts";
import { computeInlineDiffRanges, verifiedLineSpans } from "../model/InlineDiff.ts";
import {
  matchesDiffFilter,
  type DiffFilter,
  type DiffResult,
  type SemanticUnit,
  type Side,
  type TextSpan,
} from "../model/types.ts";

interface HighlightRegistryLike {
  set(key: string, highlight: unknown): void;
  delete(key: string): void;
}

interface HighlightSetLike {
  add(range: Range): void;
  clear(): void;
}

function getHighlightRegistry(): HighlightRegistryLike | undefined {
  if (typeof CSS === "undefined") return undefined;
  return (CSS as unknown as { highlights?: HighlightRegistryLike }).highlights;
}

export interface PaintableProtyle {
  element: HTMLElement;
  contentElement?: HTMLElement;
  wysiwyg: { element: HTMLElement };
  title?: { element?: HTMLElement };
}

type OverlayBoxKind = "only" | "modified" | "modified-fill" | "image-diff" | "unresolved" | "title";

interface OverlayTarget {
  element: HTMLElement;
  kind: OverlayBoxKind;
  hunkKey: string;
}

const VALID_BLOCK_ID_RE = /^\d{14}-[a-zA-Z0-9]{7}$/;
const SKIPPED_SUBTREE_SELECTOR =
  '[contenteditable="false"], [data-type~="inline-math"], .protyle-attr, .protyle-action, .protyle-attr--drag, .protyle-linenumber__rows, .protyle-icons, .callout-info, .tab-item-info';

function findEditableBlock(protyle: PaintableProtyle, blockID: string): HTMLElement | null {
  if (!VALID_BLOCK_ID_RE.test(blockID)) return null;
  const matches = protyle.wysiwyg.element.querySelectorAll<HTMLElement>(`[data-node-id="${blockID}"]`);
  for (let i = 0; i < matches.length; i++) {
    const candidate = matches[i]!;
    if (!candidate.closest(".protyle-wysiwyg__embed")) {
      return candidate;
    }
  }
  return null;
}

function findTableRowElement(block: HTMLElement, rowIndex: number): HTMLElement | null {
  const rows = block.querySelectorAll<HTMLElement>("tr:not([data-sy-table-virtual-rows])");
  return rowIndex >= 0 && rowIndex < rows.length ? rows[rowIndex]! : null;
}

interface CleanCharSlot {
  node: Text | null;
  startOffset: number;
  endOffset: number;
}

interface CleanBlockTextMap {
  text: string;
  slots: CleanCharSlot[];
}

function isIgnorableZeroWidth(code: number): boolean {
  return code === 0x0d || code === 0x200b || code === 0x2060 || code === 0xfeff;
}

/**
 * Walks editable text and `<br>` line breaks inside `block` while stripping zero-width boundary chars
 * (`\u200B`, `\u2060`, `\uFEFF`), building a clean UTF-16 index to raw `(TextNode, offset)` map.
 */
function collectBlockCleanTextMap(block: HTMLElement): CleanBlockTextMap {
  if (typeof document === "undefined" || typeof Node === "undefined") {
    return { text: "", slots: [] };
  }
  const slots: CleanCharSlot[] = [];
  let text = "";

  const walk = (node: Node): void => {
    if (node.nodeType === Node.TEXT_NODE) {
      const textNode = node as Text;
      const data = textNode.data;
      for (let i = 0; i < data.length; i++) {
        const code = data.charCodeAt(i);
        if (isIgnorableZeroWidth(code)) continue;
        text += data[i]!;
        slots.push({ node: textNode, startOffset: i, endOffset: i + 1 });
      }
      return;
    }
    if (node.nodeType !== Node.ELEMENT_NODE) return;
    const el = node as HTMLElement;
    if (el !== block && el.hasAttribute("data-node-id")) return;
    if (el.matches?.(SKIPPED_SUBTREE_SELECTOR)) return;
    if (el.tagName === "BR") {
      text += "\n";
      slots.push({ node: null, startOffset: 0, endOffset: 0 });
      return;
    }
    const children = el.childNodes;
    for (let i = 0; i < children.length; i++) {
      walk(children[i]!);
    }
  };

  walk(block);
  return { text, slots };
}

function spansToDomRanges(slots: readonly CleanCharSlot[], spans: readonly TextSpan[]): Range[] {
  if (typeof document === "undefined" || typeof document.createRange !== "function") return [];
  const ranges: Range[] = [];
  for (const span of spans) {
    const startIdx = Math.max(0, span.start);
    const endIdx = Math.min(slots.length, span.end);
    if (endIdx <= startIdx) continue;

    let firstSlot: CleanCharSlot | undefined;
    for (let i = startIdx; i < endIdx; i++) {
      if (slots[i]!.node) {
        firstSlot = slots[i]!;
        break;
      }
    }
    let lastSlot: CleanCharSlot | undefined;
    for (let i = endIdx - 1; i >= startIdx; i--) {
      if (slots[i]!.node) {
        lastSlot = slots[i]!;
        break;
      }
    }
    if (firstSlot?.node && lastSlot?.node) {
      const range = document.createRange();
      range.setStart(firstSlot.node, firstSlot.startOffset);
      range.setEnd(lastSlot.node, lastSlot.endOffset);
      ranges.push(range);
    }
  }
  return ranges;
}

function extractImageTokens(format: string): string[] {
  const out: string[] = [];
  const re = /img\([^)]*\)/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(format)) !== null) {
    out.push(match[0]);
  }
  return out;
}

function findDirectBlockImageElements(block: HTMLElement): HTMLElement[] {
  const candidates = block.querySelectorAll<HTMLElement>('[data-type~="img"], img');
  const out: HTMLElement[] = [];
  for (let i = 0; i < candidates.length; i++) {
    const el = candidates[i]!;
    if (el.closest("[data-node-id]") !== block) continue;
    // Prefer the outer `span[data-type~="img"]` wrapper over its inner `<img>` child when wrapped.
    if (el.tagName === "IMG" && el.closest('[data-type~="img"]')) continue;
    out.push(el);
  }
  return out;
}

/**
 * Non-invasive two-channel diff renderer aligned with SiYuan's `_history.scss` visual hierarchy:
 * 1. `CSS.highlights` for inline/logical-line text background without touching `[data-node-id]` DOM;
 * 2. Read-only absolute overlay outside `.protyle-wysiwyg` for whole-block tint, 3px modified/warning bars,
 *    changed image boxes, and `history-diff-focus` navigation pulse rings.
 */
export class DiffPainter {
  private readonly highlightKey: string;
  private readonly highlightSet?: HighlightSetLike;
  private readonly styleEl: HTMLStyleElement;
  private readonly overlayEl: HTMLDivElement;
  private targets: OverlayTarget[] = [];
  private focusedHunkKey?: string;
  private disposed = false;

  constructor(
    private protyle: PaintableProtyle,
    private side: Side,
  ) {
    this.highlightKey = createRuntimeId(`omnikit-diff-${side}`);
    this.styleEl = document.createElement("style");
    this.overlayEl = document.createElement("div");
    this.overlayEl.className = "omnikit-document-diff-overlay";
    this.overlayEl.setAttribute("aria-hidden", "true");
    Object.assign(this.overlayEl.style, {
      position: "absolute",
      inset: "0",
      pointerEvents: "none",
      overflow: "hidden",
      zIndex: "2",
    });

    this.updateStyleSheet();
    protyle.element.append(this.styleEl, this.overlayEl);

    const reg = getHighlightRegistry();
    if (typeof Highlight !== "undefined" && reg) {
      const hl = new Highlight();
      this.highlightSet = hl as unknown as HighlightSetLike;
      reg.set(this.highlightKey, hl);
    }
  }

  private updateStyleSheet(): void {
    const toneVar = this.side === "left" ? "var(--b3-theme-error)" : "var(--b3-theme-success)";
    const fallbackBg = this.side === "left" ? "var(--b3-card-error-background)" : "var(--b3-card-success-background)";
    this.styleEl.textContent = `
.protyle-content::highlight(${this.highlightKey}) {
  background-color: ${fallbackBg};
  background-color: color-mix(in srgb, ${toneVar} 20%, transparent);
}
@keyframes omnikit-diff-focus-pulse {
  0%, 45% {
    outline: 2px solid var(--b3-theme-primary);
    outline-offset: -2px;
  }
  100% {
    outline: 2px solid transparent;
    outline-offset: -2px;
  }
}`;
  }

  rebind(nextProtyle: PaintableProtyle, nextSide: Side): void {
    if (this.disposed) return;
    this.protyle = nextProtyle;
    this.side = nextSide;
    this.updateStyleSheet();
    if (this.styleEl.parentElement !== nextProtyle.element) {
      this.styleEl.remove();
      nextProtyle.element.append(this.styleEl);
    }
    if (this.overlayEl.parentElement !== nextProtyle.element) {
      this.overlayEl.remove();
      nextProtyle.element.append(this.overlayEl);
    }
  }

  setFocusedHunk(hunkKey: string | undefined): void {
    this.focusedHunkKey = hunkKey;
    this.redrawOverlay();
  }

  clear(): void {
    if (this.disposed) return;
    this.highlightSet?.clear();
    this.targets = [];
    this.focusedHunkKey = undefined;
    this.overlayEl.replaceChildren();
  }

  paint(
    result: DiffResult,
    allSideUnits: readonly SemanticUnit[],
    filter: DiffFilter = "all",
    focusedHunkKey?: string,
  ): void {
    if (this.disposed) return;
    this.highlightSet?.clear();
    this.targets = [];
    this.focusedHunkKey = focusedHunkKey;

    const blockExpectedLines = new Map<string, string[]>();
    const blockTotalUnitCount = new Map<string, number>();
    for (const unit of allSideUnits) {
      if (!unit.blockID) continue;
      blockTotalUnitCount.set(unit.blockID, (blockTotalUnitCount.get(unit.blockID) ?? 0) + 1);
      if (unit.tableRowIndex !== undefined) continue;
      const lines = blockExpectedLines.get(unit.blockID) ?? [];
      lines[unit.line] = unit.text;
      blockExpectedLines.set(unit.blockID, lines);
    }

    const blockOnlyUnitCount = new Map<string, number>();
    for (const hunk of result.hunks) {
      if (!matchesDiffFilter(hunk, filter)) continue;
      if (hunk.kind !== "left-only" && hunk.kind !== "right-only") continue;
      const sideUnits = this.side === "left" ? hunk.left : hunk.right;
      for (const unit of sideUnits) {
        if (unit.blockID && unit.tableRowIndex === undefined) {
          blockOnlyUnitCount.set(unit.blockID, (blockOnlyUnitCount.get(unit.blockID) ?? 0) + 1);
        }
      }
    }

    const doesBlockTextMatchExpected = (visibleText: string, expectedLines: readonly string[]): boolean => {
      const joined = expectedLines.join("\n");
      if (visibleText === joined || visibleText === `${joined}\n`) return true;
      if (expectedLines.length === 1 && expectedLines[0]!.length > 0) {
        const first = visibleText.indexOf(expectedLines[0]!);
        return first >= 0 && first === visibleText.lastIndexOf(expectedLines[0]!);
      }
      return false;
    };

    const addOverlayTarget = (element: HTMLElement, kind: OverlayBoxKind, hunkKey: string): void => {
      const existing = this.targets.find(t => t.element === element);
      if (existing) {
        if (hunkKey === this.focusedHunkKey) existing.hunkKey = hunkKey;
        if (
          kind === "unresolved" ||
          (existing.kind === "modified" && (kind === "modified-fill" || kind === "only"))
        ) {
          existing.kind = kind === "only" ? "modified-fill" : kind;
        }
        return;
      }
      this.targets.push({ element, kind, hunkKey });
    };

    for (const hunk of result.hunks) {
      if (!matchesDiffFilter(hunk, filter)) continue;

      if (hunk.kind === "title") {
        if (this.protyle.title?.element) {
          addOverlayTarget(this.protyle.title.element, "title", hunk.key);
        }
        continue;
      }

      const sideUnits = this.side === "left" ? hunk.left : hunk.right;
      const oppositeUnits = this.side === "left" ? hunk.right : hunk.left;
      const pairedByOwnIdx = new Map<number, SemanticUnit>();
      if (hunk.pairedUnits) {
        for (const pair of hunk.pairedUnits) {
          const ownIdx = this.side === "left" ? pair.leftIndex : pair.rightIndex;
          const peerIdx = this.side === "left" ? pair.rightIndex : pair.leftIndex;
          const peer = oppositeUnits[peerIdx];
          if (peer) pairedByOwnIdx.set(ownIdx, peer);
        }
      } else if (sideUnits.length === oppositeUnits.length) {
        for (let k = 0; k < sideUnits.length; k++) {
          if (sideUnits[k]!.kind === oppositeUnits[k]!.kind) {
            pairedByOwnIdx.set(k, oppositeUnits[k]!);
          }
        }
      }

      const cleanTextCache = new Map<string, CleanBlockTextMap>();
      const getCleanText = (blockID: string, blockEl: HTMLElement): CleanBlockTextMap => {
        let cached = cleanTextCache.get(blockID);
        if (!cached) {
          cached = collectBlockCleanTextMap(blockEl);
          cleanTextCache.set(blockID, cached);
        }
        return cached;
      };

      sideUnits.forEach((unit, idx) => {
        if (!unit.blockID) return;
        const block = findEditableBlock(this.protyle, unit.blockID);
        if (!block) return;

        if (!unit.reliable || hunk.kind === "unresolved") {
          const targetEl = unit.tableRowIndex !== undefined
            ? (findTableRowElement(block, unit.tableRowIndex) ?? block)
            : block;
          addOverlayTarget(targetEl, "unresolved", hunk.key);
          return;
        }

        if (hunk.kind === "left-only" || hunk.kind === "right-only") {
          if (unit.tableRowIndex !== undefined) {
            const targetEl = findTableRowElement(block, unit.tableRowIndex) ?? block;
            addOverlayTarget(targetEl, "only", hunk.key);
            for (const imgEl of findDirectBlockImageElements(targetEl)) {
              addOverlayTarget(imgEl, "image-diff", hunk.key);
            }
            return;
          }

          const totalUnitsInBlock = blockTotalUnitCount.get(unit.blockID) ?? 1;
          const onlyUnitsInBlock = blockOnlyUnitCount.get(unit.blockID) ?? 0;
          const isPartialBlockOnly = totalUnitsInBlock > 1 && onlyUnitsInBlock < totalUnitsInBlock;

          if (isPartialBlockOnly) {
            // Only specific lines inside a multi-line block (e.g. code block or `<br>` paragraph) were added/removed:
            // highlight the specific added/removed line(s) via `CSS.highlights` and mark the block with a `3px` bar
            // rather than tinting all unchanged lines of the block!
            let paintedOnlyLine = false;
            let textVerified = false;
            const expectedLines = blockExpectedLines.get(unit.blockID);
            if (expectedLines) {
              const { slots, text: visibleText } = getCleanText(unit.blockID, block);
              textVerified = doesBlockTextMatchExpected(visibleText, expectedLines);
              if (this.highlightSet && unit.text.length > 0 && textVerified) {
                const verified = verifiedLineSpans(visibleText, expectedLines, unit.line);
                if (verified) {
                  for (const r of spansToDomRanges(slots, verified)) {
                    this.highlightSet.add(r);
                    paintedOnlyLine = true;
                  }
                }
              }
            }
            addOverlayTarget(
              block,
              paintedOnlyLine || (Boolean(this.highlightSet) && textVerified && unit.text.length === 0)
                ? "modified"
                : "modified-fill",
              hunk.key,
            );
            return;
          }

          addOverlayTarget(block, "only", hunk.key);
          for (const imgEl of findDirectBlockImageElements(block)) {
            addOverlayTarget(imgEl, "image-diff", hunk.key);
          }
          return;
        }

        // `hunk.kind === "modified"`
        if (unit.tableRowIndex !== undefined) {
          const rowEl = findTableRowElement(block, unit.tableRowIndex) ?? block;
          addOverlayTarget(rowEl, "modified-fill", hunk.key);
          return;
        }

        const pairedUnit = pairedByOwnIdx.get(idx);
        let paintedInlineText = false;
        let hasExactInlinePairing = false;
        let verifiedUnpairedEmptyLine = false;

        const expectedLines = blockExpectedLines.get(unit.blockID);
        if (expectedLines) {
          const { slots, text: visibleText } = getCleanText(unit.blockID, block);
          const textVerified = doesBlockTextMatchExpected(visibleText, expectedLines);
          let localSpans: TextSpan[] | undefined;

          if (pairedUnit && pairedUnit.reliable && pairedUnit.tableRowIndex === undefined) {
            const inlineDiff = this.side === "left"
              ? computeInlineDiffRanges(unit.text, pairedUnit.text)
              : computeInlineDiffRanges(pairedUnit.text, unit.text);
            localSpans = this.side === "left" ? inlineDiff.leftRanges : inlineDiff.rightRanges;
            // Only suppress whole-block fill when the block actually exposes verifiable inline text
            // in live DOM (excluding non-text `render-node` SVG charts like Mermaid/ECharts).
            if (textVerified && this.highlightSet && unit.text !== pairedUnit.text) {
              hasExactInlinePairing = true;
            }
          } else if (!pairedUnit && textVerified && this.highlightSet && unit.text.length === 0) {
            // Verified empty-line insertion/deletion inside a modified hunk (e.g. trailing or inner blank line
            // in a code block): keep the `3px` modified bar without escalating the whole block to `modified-fill`.
            verifiedUnpairedEmptyLine = true;
          }

          if (this.highlightSet && unit.text.length > 0 && (localSpans === undefined || localSpans.length > 0)) {
            const verified = verifiedLineSpans(visibleText, expectedLines, unit.line, localSpans);
            if (verified) {
              const domRanges = spansToDomRanges(slots, verified);
              for (const r of domRanges) {
                this.highlightSet.add(r);
                paintedInlineText = true;
              }
            }
          }
        }

        // Highlight changed inline/standalone images inside modified blocks so opaque images are visually unmistakable.
        const ownImages = extractImageTokens(unit.format);
        if (ownImages.length > 0) {
          const peerImages = pairedUnit ? extractImageTokens(pairedUnit.format) : [];
          const blockImgEls = findDirectBlockImageElements(block);
          blockImgEls.forEach((imgEl, imgIdx) => {
            if (!pairedUnit || ownImages[imgIdx] !== peerImages[imgIdx]) {
              addOverlayTarget(imgEl, "image-diff", hunk.key);
            }
          });
        }

        addOverlayTarget(
          block,
          paintedInlineText || hasExactInlinePairing || verifiedUnpairedEmptyLine ? "modified" : "modified-fill",
          hunk.key,
        );
      });
    }

    this.redrawOverlay();
  }

  redrawOverlay(): void {
    if (this.disposed) return;
    this.overlayEl.replaceChildren();
    if (this.targets.length === 0) return;

    const hostRect = this.protyle.element.getBoundingClientRect();
    const scroller = this.protyle.contentElement ?? this.protyle.wysiwyg.element.parentElement;
    const viewportRect = scroller?.getBoundingClientRect() ?? hostRect;
    const minTop = Math.max(0, viewportRect.top - hostRect.top);
    const maxBottom = Math.min(hostRect.height, viewportRect.bottom - hostRect.top);

    const sideTone = this.side === "left" ? "var(--b3-theme-error)" : "var(--b3-theme-success)";
    const sideFallback = this.side === "left" ? "var(--b3-card-error-background)" : "var(--b3-card-success-background)";

    for (const target of this.targets) {
      if (!target.element.isConnected) continue;
      const rect = target.element.getBoundingClientRect();
      const top = Math.max(minTop, rect.top - hostRect.top);
      const bottom = Math.min(maxBottom, rect.bottom - hostRect.top);
      if (bottom - top < 1) continue;

      const box = document.createElement("div");
      const left = Math.max(0, rect.left - hostRect.left);
      const width = Math.max(0, Math.min(rect.width, hostRect.width - left));
      Object.assign(box.style, {
        position: "absolute",
        top: `${top}px`,
        left: `${left}px`,
        width: `${width}px`,
        height: `${bottom - top}px`,
        boxSizing: "border-box",
        pointerEvents: "none",
      });

      if (target.kind === "only") {
        box.style.borderInlineStart = `3px solid ${sideTone}`;
        box.style.backgroundColor = sideFallback;
        box.style.setProperty("background-color", `color-mix(in srgb, ${sideTone} 15%, transparent)`);
      } else if (target.kind === "modified") {
        // Matches SiYuan `_history.scss` `[data-history-diff~="modified"]` 3px primary bar while inline text has red/green HL.
        box.style.borderInlineStart = "3px solid var(--b3-theme-primary)";
      } else if (target.kind === "modified-fill" || target.kind === "title") {
        box.style.borderInlineStart = "3px solid var(--b3-theme-primary)";
        box.style.backgroundColor = sideFallback;
        box.style.setProperty("background-color", `color-mix(in srgb, ${sideTone} 12%, transparent)`);
      } else if (target.kind === "image-diff") {
        box.style.border = `2px solid ${sideTone}`;
        box.style.borderRadius = "4px";
        box.style.backgroundColor = sideFallback;
        box.style.setProperty("background-color", `color-mix(in srgb, ${sideTone} 16%, transparent)`);
      } else if (target.kind === "unresolved") {
        box.style.borderInlineStart = "3px dashed var(--b3-theme-warning, var(--b3-theme-secondary))";
        box.style.setProperty(
          "background-color",
          "color-mix(in srgb, var(--b3-theme-warning, var(--b3-theme-secondary)) 10%, transparent)",
        );
      }

      if (this.focusedHunkKey && target.hunkKey === this.focusedHunkKey && target.kind !== "image-diff") {
        box.style.animation = "omnikit-diff-focus-pulse 1.2s ease-out";
      }

      this.overlayEl.append(box);
    }
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.highlightSet?.clear();
    getHighlightRegistry()?.delete(this.highlightKey);
    this.styleEl.remove();
    this.overlayEl.remove();
    this.targets = [];
  }
}
