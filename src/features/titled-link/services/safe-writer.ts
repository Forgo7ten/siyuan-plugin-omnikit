import type { LinkActionResult, LinkOccurrenceTarget, TitledLinkProtyle } from "../policy/types.ts";
import { isAbortError } from "../../../core/feedback/UiFeedback.ts";
import { withBlockWriteLease } from "../../../core/host/BlockWriteLease.ts";
import { isInsideProtectedContainer } from "../../../core/host/dom.ts";
import type { KernelClient } from "../../../core/host/KernelClient.ts";
import { getKernelOutcome } from "../../../core/host/kernelOutcome.ts";
import { Logger } from "../../../core/host/Logger.ts";
import {
  resolveProtyleRunner,
  resolveEditorRootID,
  resolveNotebookID,
} from "../../../core/host/ProtyleAdapter.ts";

export type LinkWriteResult = LinkActionResult;

export const DEFAULT_IME_TIMEOUT_MS = 5_000;
export const DEFAULT_IME_POLL_MS = 500;

export type LinkWriterKernel = Pick<KernelClient, "post">;

export interface CommitLinkTitleOptions {
  replaceTitle: boolean;
  signal?: AbortSignal;
  kernel?: LinkWriterKernel;
  isComposing?: (protyle?: unknown) => boolean;
  imeTimeoutMs?: number;
  imePollMs?: number;
  isCurrent?: () => boolean;
}

/** One title update in a block-level write group. */
export interface GroupedLinkTitleUpdate {
  readonly target: LinkOccurrenceTarget;
  readonly title: string;
  readonly isCurrent?: () => boolean;
}

interface BlockDOM { id?: string; dom?: string }
interface BlockInfo { rootID?: string; box?: string }

function linkElements(block: HTMLElement): HTMLElement[] {
  return [...block.querySelectorAll<HTMLElement>('span[data-type~="a"]')];
}

/** Capture one occurrence before asynchronous title fetching begins. */
export function captureLinkTarget(
  link: HTMLElement,
  protyle: any,
  blockHTMLCache?: Map<HTMLElement, string>,
): LinkOccurrenceTarget | null {
  if (isInsideProtectedContainer(link)) return null;
  const runner = resolveProtyleRunner(protyle) as TitledLinkProtyle | null;
  const block = link.closest<HTMLElement>("[data-node-id]");
  const blockID = block?.getAttribute("data-node-id") ?? "";
  const rootID = resolveEditorRootID(protyle);
  const notebook = resolveNotebookID(protyle);
  const href = link.getAttribute("data-href");
  if (!block || !blockID || typeof rootID !== "string" || !rootID ||
      typeof notebook !== "string" || !notebook || typeof href !== "string" || !href) return null;
  const ordinal = linkElements(block).indexOf(link);
  if (ordinal < 0) return null;
  const text = link.textContent ?? "";
  let originalBlockHTML = blockHTMLCache?.get(block);
  if (originalBlockHTML === undefined) {
    originalBlockHTML = block.outerHTML;
    blockHTMLCache?.set(block, originalBlockHTML);
  }
  return {
    protyle: runner ?? undefined,
    notebook,
    rootID,
    blockID,
    ordinal,
    linkElement: link,
    blockElement: block,
    originalHref: href,
    originalText: text,
    originalTitle: link.getAttribute("data-title"),
    originalBlockHTML,
  };
}

function isActiveEditor(target: LinkOccurrenceTarget): boolean {
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

function isLiveOccurrenceValid(target: LinkOccurrenceTarget): boolean {
  const link = target.linkElement;
  const block = target.blockElement;
  if (!link || !block) return false;
  if (block.isConnected === false || link.isConnected === false) return false;
  if (typeof link.closest === "function" && link.closest("[data-node-id]") !== block) return false;
  if (block.getAttribute("data-node-id") !== target.blockID) return false;
  const currentHref = link.getAttribute("data-href");
  const currentText = link.textContent ?? "";
  const currentTitle = link.getAttribute("data-title");
  return currentHref === target.originalHref &&
    currentText === target.originalText &&
    currentTitle === target.originalTitle;
}

function applyLinkTitle(link: HTMLElement, title: string, replaceTitle: boolean): void {
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
      link.contains(range.endContainer)
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

function parseBlockFromDOM(html: string, blockID: string): HTMLElement | null {
  if (typeof DOMParser === "undefined") return null;
  const parsed = new DOMParser().parseFromString(html, "text/html");
  const block = [...parsed.querySelectorAll<HTMLElement>("[data-node-id]")]
    .find(element => element.getAttribute("data-node-id") === blockID);
  if (!block || block.querySelector("[data-node-id]")) return null;
  return block;
}

/** Remove kernel render-only attributes (e.g. parent-heading) before persisting block DOM via updateBlock. */
function stripRenderOnlyAttributes(root: HTMLElement): void {
  root.removeAttribute("parent-heading");
  for (const element of root.querySelectorAll<HTMLElement>("[parent-heading]")) {
    element.removeAttribute("parent-heading");
  }
}

/** Remove kernel volatile attributes (parent-heading and updated) on verification copies only. */
function stripKernelVolatileAttributes(root: HTMLElement): void {
  stripRenderOnlyAttributes(root);
  root.removeAttribute("updated");
  for (const element of root.querySelectorAll<HTMLElement>("[updated]")) {
    element.removeAttribute("updated");
  }
}

function abortAwareDelay(ms: number, signal?: AbortSignal): Promise<boolean> {
  if (signal?.aborted) return Promise.resolve(false);
  return new Promise(resolve => {
    const timer = setTimeout(() => { cleanup(); resolve(true); }, ms);
    const onAbort = () => { clearTimeout(timer); cleanup(); resolve(false); };
    const cleanup = () => signal?.removeEventListener("abort", onAbort);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

async function awaitCompositionEnd(
  options: CommitLinkTitleOptions,
  protyle: unknown,
  isStillActive: () => boolean,
): Promise<boolean> {
  if (!options.isComposing) return true;
  const timeout = options.imeTimeoutMs ?? DEFAULT_IME_TIMEOUT_MS;
  const poll = Math.max(1, options.imePollMs ?? DEFAULT_IME_POLL_MS);
  const deadline = Date.now() + timeout;
  while (options.isComposing(protyle)) {
    if (!isStillActive()) return true;
    const remaining = deadline - Date.now();
    if (remaining <= 0) return false;
    if (!await abortAwareDelay(Math.min(poll, remaining), options.signal)) return false;
  }
  return true;
}

function isUpdateCurrent(update: GroupedLinkTitleUpdate, options: CommitLinkTitleOptions): boolean {
  const check = update.isCurrent ?? options.isCurrent;
  return check ? check() : true;
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
  if (typeof globalThis.getSelection !== "function" ||
      typeof document === "undefined" ||
      typeof document.createRange !== "function") {
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

async function commitInactiveTitles(
  updates: readonly GroupedLinkTitleUpdate[],
  options: CommitLinkTitleOptions,
): Promise<LinkWriteResult[]> {
  const mapActive = (value: LinkWriteResult) =>
    updates.map(u => isUpdateCurrent(u, options) ? value : ("superseded" as LinkWriteResult));
  const conflict = () => mapActive("conflict");
  const failed = () => mapActive("failed");
  const unknown = () => mapActive("unknown");
  const aborted = () => updates.map(() => "aborted" as LinkWriteResult);
  if (!options.kernel) return failed();
  const first = updates[0].target;

  let results: LinkWriteResult[];
  let expectedHTML: string;
  try {
    const infoRes = await options.kernel.post<BlockInfo>("/api/block/getBlockInfo", {
      id: first.blockID,
      ...(first.notebook ? { notebook: first.notebook } : {}),
    }, { signal: options.signal, timeout: 30_000 });
    if (!infoRes?.data || typeof infoRes.data.rootID !== "string" || !infoRes.data.rootID ||
        (first.notebook && (typeof infoRes.data.box !== "string" || !infoRes.data.box))) {
      return failed();
    }
    if (infoRes.data.rootID !== first.rootID || (first.notebook && infoRes.data.box !== first.notebook)) {
      Logger.shared.debug("后台写前校验块归属不一致，判定冲突", {
        blockID: first.blockID,
        expectedRootID: first.rootID,
        actualRootID: infoRes.data.rootID,
        expectedBox: first.notebook,
        actualBox: infoRes.data.box,
      });
      return conflict();
    }
    if (updates.every(u => !isUpdateCurrent(u, options))) {
      return updates.map(() => "superseded");
    }

    const response = await options.kernel.post<BlockDOM>("/api/block/getBlockDOM", {
      id: first.blockID,
      notebook: first.notebook,
    }, { signal: options.signal });
    if (response?.data?.id !== first.blockID || typeof response?.data?.dom !== "string" || !response.data.dom) {
      return failed();
    }
    const activeFlags = updates.map(u => isUpdateCurrent(u, options));
    if (!activeFlags.some(Boolean)) {
      return updates.map(() => "superseded");
    }
    const block = parseBlockFromDOM(response.data.dom, first.blockID);
    if (!block) return failed();
    stripRenderOnlyAttributes(block);
    if (first.originalBlockHTML !== undefined) {
      const baseline = parseBlockFromDOM(first.originalBlockHTML, first.blockID);
      if (!baseline) return failed();
      stripRenderOnlyAttributes(baseline);
      if (baseline.outerHTML !== block.outerHTML) {
        Logger.shared.debug("后台写前块基线 HTML 已变化，判定冲突", { blockID: first.blockID });
        return conflict();
      }
    }

    const links = linkElements(block);
    const targetLinks: Array<HTMLElement | undefined> = [];
    for (let i = 0; i < updates.length; i++) {
      if (!activeFlags[i]) {
        targetLinks.push(undefined);
        continue;
      }
      const { target } = updates[i];
      const link = links[target.ordinal];
      if (!link ||
          isInsideProtectedContainer(link) ||
          link.getAttribute("data-href") !== target.originalHref ||
          (link.textContent ?? "") !== target.originalText ||
          link.getAttribute("data-title") !== target.originalTitle) {
        Logger.shared.debug("后台写前链接锚点不匹配，判定冲突", {
          blockID: first.blockID,
          ordinal: target.ordinal,
          hasLink: Boolean(link),
        });
        return conflict();
      }
      targetLinks.push(link);
    }

    results = updates.map(({ title }, index) => {
      if (!activeFlags[index]) return "superseded";
      const link = targetLinks[index]!;
      return (link.textContent ?? "") === title &&
        (!options.replaceTitle || link.getAttribute("data-title") === title)
        ? "unchanged"
        : "updated";
    });
    if (!results.some(r => r === "updated")) return results;

    for (let i = 0; i < updates.length; i++) {
      if (results[i] !== "updated") continue;
      const link = targetLinks[i]!;
      link.textContent = updates[i].title;
      if (options.replaceTitle) {
        link.setAttribute("data-title", updates[i].title);
      }
    }
    expectedHTML = block.outerHTML;
  } catch (error) {
    if (options.signal?.aborted || isAbortError(error)) {
      return aborted();
    }
    return failed();
  }

  const mapPostResults = (activeValue: LinkWriteResult) =>
    results.map((result, index) =>
      result === "superseded" || !isUpdateCurrent(updates[index], options) ? "superseded" : activeValue,
    );

  try {
    await options.kernel.post("/api/block/updateBlock", {
      id: first.blockID,
      dataType: "dom",
      data: expectedHTML,
      lockType: true,
    }, { signal: options.signal, timeout: 30_000 });
    return results;
  } catch (error) {
    const outcome = getKernelOutcome(error);
    if (outcome === "not-sent") {
      Logger.shared.debug("后台 updateBlock 发前已中止", { blockID: first.blockID });
      return aborted();
    }
    if (outcome === "rejected") {
      Logger.shared.debug("后台 updateBlock 提交明确失败", { blockID: first.blockID, outcome, error });
      return failed();
    }
    if (options.signal?.aborted) {
      Logger.shared.debug("后台 updateBlock 发后已中止，返回 unknown", { blockID: first.blockID });
      return unknown();
    }
    try {
      const verifyRes = await options.kernel.post<BlockDOM>("/api/block/getBlockDOM", {
        id: first.blockID,
        notebook: first.notebook,
      }, { signal: options.signal, timeout: 10_000 });
      if (verifyRes?.data?.id !== first.blockID || typeof verifyRes?.data?.dom !== "string" || !verifyRes.data.dom) {
        return mapPostResults("unknown");
      }
      const latestBlock = parseBlockFromDOM(verifyRes.data.dom, first.blockID);
      const expectedBlock = parseBlockFromDOM(expectedHTML, first.blockID);
      if (!latestBlock || !expectedBlock) return mapPostResults("unknown");
      stripKernelVolatileAttributes(latestBlock);
      stripKernelVolatileAttributes(expectedBlock);
      if (latestBlock.outerHTML === expectedBlock.outerHTML) {
        Logger.shared.debug("unknown 重读核验确认已落盘", { blockID: first.blockID });
        return results;
      }

      if (first.originalBlockHTML !== undefined) {
        const baselineBlock = parseBlockFromDOM(first.originalBlockHTML, first.blockID);
        if (baselineBlock) {
          stripKernelVolatileAttributes(baselineBlock);
          if (latestBlock.outerHTML === baselineBlock.outerHTML) {
            Logger.shared.debug("unknown 重读核验仍为基线未变化", { blockID: first.blockID });
            return results.map((result, index) =>
              result === "superseded" || !isUpdateCurrent(updates[index], options)
                ? "superseded"
                : result === "unchanged"
                  ? "unchanged"
                  : "unknown",
            );
          }
        }
      }
      Logger.shared.debug("unknown 重读核验发现并发变更，判定冲突", { blockID: first.blockID });
      return mapPostResults("conflict");
    } catch (verifyError) {
      Logger.shared.debug("unknown 重读核验请求异常", { blockID: first.blockID, verifyError });
      return mapPostResults("unknown");
    }
  }
}

/**
 * Re-read and verify the exact occurrence before mutating the live block.
 * In active Protyle editors:
 * - Live DOM is real-time truth.
 * - Modifies link element text/title in memory DOM and commits via updateTransactionElement.
 * - Supports native Ctrl+Z undo stack.
 * In inactive/background updates:
 * - Verifies live rootID/box, reads block DOM, patches link occurrence, posts updateBlock and trusts code: 0.
 */
export async function commitLinkTitle(
  target: LinkOccurrenceTarget,
  title: string,
  options: CommitLinkTitleOptions,
): Promise<LinkWriteResult> {
  const [result] = await commitLinkTitles([{ target, title, isCurrent: options.isCurrent }], options);
  return result ?? "conflict";
}

/**
 * Commit several occurrences from one block in one native transaction or updateBlock call.
 * In active Protyle editors:
 * - All targets in the group are verified against the live DOM and updated in a single
 *   protyle.updateTransactionElement call.
 * In inactive/background updates:
 * - All targets are verified against live block identity and block DOM, and committed in a single
 *   /api/block/updateBlock call.
 */
export async function commitLinkTitles(
  updates: readonly GroupedLinkTitleUpdate[],
  options: CommitLinkTitleOptions,
): Promise<LinkWriteResult[]> {
  if (updates.length === 0) return [];
  const conflict = () => updates.map(u => isUpdateCurrent(u, options) ? ("conflict" as LinkWriteResult) : ("superseded" as LinkWriteResult));
  const aborted = () => updates.map(() => "aborted" as LinkWriteResult);
  if (options.signal?.aborted) return aborted();

  const first = updates[0].target;
  try {
    return await withBlockWriteLease(first.notebook, first.blockID, options.signal, async () => {
      if (updates.every(u => !isUpdateCurrent(u, options))) {
        return updates.map(() => "superseded");
      }
      if (isActiveEditor(first)) {
        if (!await awaitCompositionEnd(options, first.protyle, () => isActiveEditor(first))) {
          const outcome = options.signal?.aborted ? "aborted" : "ime-timeout";
          Logger.shared.debug("等待 IME 输入结束未通过，跳过标题写入", { blockID: first.blockID, outcome });
          return options.signal?.aborted
            ? aborted()
            : updates.map(u => isUpdateCurrent(u, options) ? "ime-timeout" : "superseded");
        }
      }
      const activeFlags = updates.map(u => isUpdateCurrent(u, options));
      if (!activeFlags.some(Boolean)) {
        return updates.map(() => "superseded");
      }

      if (updates.some(({ target }) =>
        target.notebook !== first.notebook ||
        target.blockID !== first.blockID ||
        target.rootID !== first.rootID ||
        (target.originalBlockHTML !== undefined && first.originalBlockHTML !== undefined && target.originalBlockHTML !== first.originalBlockHTML)
      )) {
        return conflict();
      }

      const ordinals = new Set<number>();
      for (let i = 0; i < updates.length; i++) {
        if (!activeFlags[i]) continue;
        if (ordinals.has(updates[i].target.ordinal)) return conflict();
        ordinals.add(updates[i].target.ordinal);
      }

      // Inactive or background update path
      if (!isActiveEditor(first)) {
        if (updates.some(({ target }) => isActiveEditor(target))) {
          Logger.shared.debug("块内写组活跃编辑器状态不一致，判定冲突", { blockID: first.blockID });
          return conflict();
        }
        Logger.shared.debug("原编辑器已关闭或不可用，切换为后台 updateBlock 写入路径", { blockID: first.blockID });
        return commitInactiveTitles(updates, options);
      }

      // Active Protyle editor path: non-superseded targets must belong to the same live block
      if (updates.some(({ target }, index) =>
        activeFlags[index] && (
          !isActiveEditor(target) ||
          target.blockElement !== first.blockElement ||
          target.protyle !== first.protyle ||
          !isLiveOccurrenceValid(target)
        )
      )) {
        Logger.shared.debug("活跃编辑器实时 DOM 锚点校验未通过，判定冲突", { blockID: first.blockID });
        return conflict();
      }

      const results: LinkWriteResult[] = updates.map(({ target, title }, index) => {
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
        .map(({ target }, index) => results[index] === "updated" ? captureCollapsedCaretInLink(target.linkElement!) : undefined)
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
        return updates.map((u) => !isUpdateCurrent(u, options) ? "superseded" : options.signal?.aborted ? "aborted" : "failed");
      }
    });
  } catch (error) {
    if (options.signal?.aborted || isAbortError(error)) {
      return aborted();
    }
    throw error;
  }
}
