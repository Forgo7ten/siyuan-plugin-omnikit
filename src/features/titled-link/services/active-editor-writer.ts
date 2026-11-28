import type { LinkActionResult, LinkOccurrenceTarget } from "../policy/types.ts";
import { Logger } from "../../../core/host/Logger.ts";
import { isProtyleReadOnly } from "../../../core/host/ProtyleAdapter.ts";
import {
  isUpdateCurrent,
  mapUpdatesByCurrent,
  type CommitLinkTitleOptions,
  type GroupedLinkTitleUpdate,
} from "./block-dom-snapshot.ts";

export function isActiveEditor(target: LinkOccurrenceTarget): boolean {
  const protyle = target.protyle;
  if (!protyle || typeof protyle.updateTransactionElement !== "function") return false;
  const host = (protyle as any).protyle ?? protyle;
  if ((protyle as any).destroyed === true || host?.destroyed === true) return false;
  if (host?.element) {
    if (host.element.isConnected === false) return false;
    if (host.element.classList && !host.element.classList.contains("protyle")) return false;
  }
  if (host?.wysiwyg?.element && host.wysiwyg.element.isConnected === false) return false;
  if (typeof host?.block?.rootID === "string" && host.block.rootID.length > 0 && host.block.rootID !== target.rootID) {
    return false;
  }
  return true;
}

export function isLiveOccurrenceValid(target: LinkOccurrenceTarget): boolean {
  const link = target.linkElement;
  const block = target.blockElement;
  if (!link || !block) return false;
  if (block.isConnected === false || link.isConnected === false) return false;
  if (typeof link.closest === "function" && link.closest("[data-node-id]") !== block) return false;
  if (block.getAttribute("data-node-id") !== target.blockID) return false;
  const currentHref = link.getAttribute("data-href");
  const currentText = link.textContent ?? "";
  const currentTitle = link.getAttribute("data-title");
  return (
    currentHref === target.originalHref &&
    currentText === target.originalText &&
    currentTitle === target.originalTitle
  );
}

export function applyLinkTitle(link: HTMLElement, title: string, replaceTitle: boolean): void {
  const canRestoreCaret =
    typeof globalThis.getSelection === "function" &&
    typeof document !== "undefined" &&
    typeof document.createRange === "function" &&
    typeof link.contains === "function";
  const selection = canRestoreCaret ? globalThis.getSelection() : null;
  let restoreCaret = false;
  if (selection && selection.rangeCount > 0) {
    const range = selection.getRangeAt(0);
    restoreCaret = Boolean(
      range.collapsed &&
      link.contains(range.startContainer) &&
      link.contains(range.endContainer),
    );
  }

  link.textContent = title;
  if (replaceTitle) {
    link.setAttribute("data-title", title);
  }

  if (restoreCaret && selection) {
    const nextRange = document.createRange();
    const firstChild = link.firstChild;
    if (firstChild && firstChild.nodeType === 3) {
      nextRange.setStart(firstChild, firstChild.textContent?.length ?? 0);
    } else {
      nextRange.setStart(link, link.childNodes.length);
    }
    nextRange.collapse(true);
    selection.removeAllRanges();
    selection.addRange(nextRange);
  }
}

function captureCollapsedCaretInLink(link: HTMLElement): { link: HTMLElement; offset: number } | undefined {
  if (typeof globalThis.getSelection !== "function" || typeof link.contains !== "function") return undefined;
  const selection = globalThis.getSelection();
  if (!selection || selection.rangeCount <= 0) return undefined;
  const range = selection.getRangeAt(0);
  if (!range.collapsed || !link.contains(range.startContainer) || !link.contains(range.endContainer)) {
    return undefined;
  }
  if (range.startContainer === link.firstChild && link.firstChild?.nodeType === 3) {
    return { link, offset: range.startOffset };
  }
  return { link, offset: range.startOffset > 0 ? (link.textContent?.length ?? 0) : 0 };
}

function restoreCollapsedCaretOffset(link: HTMLElement, offset: number): void {
  if (
    typeof globalThis.getSelection !== "function" ||
    typeof document === "undefined" ||
    typeof document.createRange !== "function"
  ) {
    return;
  }
  const selection = globalThis.getSelection();
  if (!selection) return;
  const nextRange = document.createRange();
  const firstChild = link.firstChild;
  if (firstChild && firstChild.nodeType === 3) {
    const len = firstChild.textContent?.length ?? 0;
    nextRange.setStart(firstChild, Math.min(Math.max(0, offset), len));
  } else {
    nextRange.setStart(link, Math.min(Math.max(0, offset), link.childNodes.length));
  }
  nextRange.collapse(true);
  selection.removeAllRanges();
  selection.addRange(nextRange);
}

export async function commitActiveTitles(
  updates: readonly GroupedLinkTitleUpdate[],
  activeFlags: readonly boolean[],
  options: CommitLinkTitleOptions,
): Promise<LinkActionResult[]> {
  const first = updates[0].target;

  if (
    isProtyleReadOnly(first.protyle, first.blockElement) ||
    updates.some(({ target }, index) => activeFlags[index] && isProtyleReadOnly(target.protyle, target.linkElement))
  ) {
    Logger.shared.debug("活跃编辑器或目标块处于只读状态，阻断标题写入", { blockID: first.blockID });
    return mapUpdatesByCurrent(updates, options, "failed");
  }

  if (
    updates.some(({ target }, index) =>
      activeFlags[index] && (
        !isActiveEditor(target) ||
        target.blockElement !== first.blockElement ||
        target.protyle !== first.protyle ||
        !isLiveOccurrenceValid(target)
      ),
    )
  ) {
    Logger.shared.debug("活跃编辑器实时 DOM 锚点校验未通过，判定冲突", { blockID: first.blockID });
    return mapUpdatesByCurrent(updates, options, "conflict");
  }

  const results: LinkActionResult[] = updates.map(({ target, title }, index) => {
    if (!activeFlags[index]) return "superseded";
    const link = target.linkElement!;
    return (link.textContent ?? "") === title &&
      (!options.replaceTitle || link.getAttribute("data-title") === title)
      ? "unchanged"
      : "updated";
  });
  if (!results.some(result => result === "updated")) {
    Logger.shared.debug("活跃编辑器链接标题均无变化，跳过事务提交", { blockID: first.blockID });
    return results;
  }

  const oldHTML = first.blockElement!.outerHTML;
  const previousValues = updates.map(({ target }) => ({
    text: target.linkElement!.textContent,
    title: target.linkElement!.getAttribute("data-title"),
  }));
  const capturedCaret = updates
    .map(({ target }, index) => (results[index] === "updated" ? captureCollapsedCaretInLink(target.linkElement!) : undefined))
    .find(item => item !== undefined);

  for (let index = 0; index < updates.length; index += 1) {
    if (results[index] !== "updated") continue;
    const { target, title } = updates[index];
    applyLinkTitle(target.linkElement!, title, options.replaceTitle);
  }

  try {
    await first.protyle!.updateTransactionElement(first.blockElement!, oldHTML);
    Logger.shared.debug("活跃编辑器事务提交链接标题完成", { blockID: first.blockID, results });
    return results;
  } catch (txError) {
    Logger.shared.debug("活跃编辑器事务提交失败，回滚链接文本与光标", { blockID: first.blockID, error: txError });
    for (let index = 0; index < updates.length; index += 1) {
      if (results[index] !== "updated") continue;
      const { target } = updates[index];
      target.linkElement!.textContent = previousValues[index].text;
      const oldTitle = previousValues[index].title;
      if (oldTitle === null) {
        target.linkElement!.removeAttribute("data-title");
      } else {
        target.linkElement!.setAttribute("data-title", oldTitle);
      }
      if (capturedCaret && capturedCaret.link === target.linkElement) {
        restoreCollapsedCaretOffset(target.linkElement!, capturedCaret.offset);
      }
    }
    return updates.map(u => (!isUpdateCurrent(u, options) ? "superseded" : options.signal?.aborted ? "aborted" : "failed"));
  }
}
