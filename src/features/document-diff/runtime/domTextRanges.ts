import { isValidBlockID, type TextSpan } from "../model/types.ts";

export interface CleanCharSlot {
  node: Text | null;
  startOffset: number;
  endOffset: number;
}

export interface CleanBlockTextMap {
  text: string;
  slots: CleanCharSlot[];
}

const SKIPPED_SUBTREE_SELECTOR =
  '[contenteditable="false"], [data-type~="inline-math"], .protyle-attr, .protyle-action, .protyle-attr--drag, .protyle-linenumber__rows, .protyle-icons, .callout-info, .tab-item-info';

export function findEditableBlock(
  protyle: { wysiwyg: { element: HTMLElement } },
  blockID: string,
): HTMLElement | null {
  if (!isValidBlockID(blockID)) return null;
  const matches = protyle.wysiwyg.element.querySelectorAll<HTMLElement>(`[data-node-id="${blockID}"]`);
  for (let i = 0; i < matches.length; i++) {
    const candidate = matches[i]!;
    if (!candidate.closest(".protyle-wysiwyg__embed")) {
      return candidate;
    }
  }
  return null;
}

export function findTableRowElement(block: HTMLElement, rowIndex: number): HTMLElement | null {
  const rows = block.querySelectorAll<HTMLElement>("tr:not([data-sy-table-virtual-rows])");
  return rowIndex >= 0 && rowIndex < rows.length ? rows[rowIndex]! : null;
}

function isIgnorableZeroWidth(code: number): boolean {
  return code === 0x0d || code === 0x200b || code === 0x2060 || code === 0xfeff;
}

/**
 * Walks editable text and `<br>` line breaks inside `block` while stripping zero-width boundary chars
 * (`\u200B`, `\u2060`, `\uFEFF`), building a clean UTF-16 index to raw `(TextNode, offset)` map.
 */
export function collectBlockCleanTextMap(block: HTMLElement): CleanBlockTextMap {
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

export function doesBlockTextMatchExpected(
  visibleText: string,
  expectedLines: readonly string[],
): boolean {
  const joined = expectedLines.join("\n");
  if (visibleText === joined || visibleText === `${joined}\n`) return true;
  if (expectedLines.length === 1 && expectedLines[0]!.length > 0) {
    const first = visibleText.indexOf(expectedLines[0]!);
    return first >= 0 && first === visibleText.lastIndexOf(expectedLines[0]!);
  }
  return false;
}

export function spansToDomRanges(
  slots: readonly CleanCharSlot[],
  spans: readonly TextSpan[],
): Range[] {
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

export function extractImageTokens(format: string): string[] {
  const out: string[] = [];
  const re = /img\([^)]*\)/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(format)) !== null) {
    out.push(match[0]);
  }
  return out;
}

export function computeChangedTokenIndices(
  ownTokens: readonly string[],
  peerTokens: readonly string[],
): number[] {
  const n = ownTokens.length;
  if (n === 0) return [];
  const m = peerTokens.length;
  if (m === 0) {
    return Array.from({ length: n }, (_, idx) => idx);
  }
  const width = m + 1;
  const dp = new Uint16Array((n + 1) * width);
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      const idx = i * width + j;
      if (ownTokens[i] === peerTokens[j]) {
        dp[idx] = dp[(i + 1) * width + j + 1]! + 1;
      } else {
        const down = dp[(i + 1) * width + j]!;
        const right = dp[i * width + j + 1]!;
        dp[idx] = down >= right ? down : right;
      }
    }
  }
  const changed: number[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (ownTokens[i] === peerTokens[j]) {
      i++;
      j++;
    } else if (dp[(i + 1) * width + j]! >= dp[i * width + j + 1]!) {
      changed.push(i++);
    } else {
      j++;
    }
  }
  while (i < n) {
    changed.push(i++);
  }
  return changed;
}

export function findDirectBlockImageElements(rootEl: HTMLElement): HTMLElement[] {
  const ownerBlock = rootEl.closest<HTMLElement>("[data-node-id]") ?? rootEl;
  const candidates = rootEl.querySelectorAll<HTMLElement>('[data-type~="img"], img');
  const out: HTMLElement[] = [];
  for (let i = 0; i < candidates.length; i++) {
    const el = candidates[i]!;
    if (el.closest("[data-node-id]") !== ownerBlock) continue;
    // Prefer the outer `span[data-type~="img"]` wrapper over its inner `<img>` child when wrapped.
    if (el.tagName === "IMG" && el.closest('[data-type~="img"]')) continue;
    out.push(el);
  }
  return out;
}
