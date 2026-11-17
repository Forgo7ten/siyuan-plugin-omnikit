import type { LinkOccurrenceTarget, TitledLinkProtyle } from "../policy/types.ts";
import { resolveProtyleRunner, resolveEditorRootID, resolveNotebookID } from "../../../core/host/ProtyleAdapter.ts";

export type LinkWriteResult = "updated" | "unchanged" | "conflict" | "aborted";

export interface LinkWriterKernel {
  post<T>(path: string, body: unknown, options?: { signal?: AbortSignal; timeout?: number }): Promise<{ data: T; code?: number } | { code: number; data?: T; msg?: string }>;
}

export interface CommitLinkTitleOptions {
  replaceTitle: boolean;
  signal?: AbortSignal;
  kernel?: LinkWriterKernel;
  isComposing?: () => boolean;
  imeTimeoutMs?: number;
  imePollMs?: number;
}

/** One title update in a block-level write group. */
export interface GroupedLinkTitleUpdate {
  readonly target: LinkOccurrenceTarget;
  readonly title: string;
}

interface BlockDOM { id?: string; dom?: string }

const blockTails = new Map<string, Promise<void>>();

/** Serialize this plugin's writes to a block; SiYuan's update API is not an atomic CAS. */
export function withLinkBlockLease<T>(key: string, operation: () => Promise<T>): Promise<T> {
  const previous = blockTails.get(key) ?? Promise.resolve();
  let release!: () => void;
  const hold = new Promise<void>(resolve => { release = resolve; });
  const tail = previous.catch(() => undefined).then(() => hold);
  blockTails.set(key, tail);
  return previous.catch(() => undefined).then(operation).finally(() => {
    release();
    if (blockTails.get(key) === tail) blockTails.delete(key);
  });
}

function linkElements(block: HTMLElement): HTMLElement[] {
  return [...block.querySelectorAll<HTMLElement>('span[data-type~="a"]')];
}

/**
 * Resolve a runnable TitledLinkProtyle target from either a Protyle instance, a test mock,
 * or SiYuan's IProtyle event detail wrapper (which exposes `getInstance(): Protyle`).
 */
export function resolveTitledLinkProtyle(protyle: any): TitledLinkProtyle | null {
  return resolveProtyleRunner(protyle) as TitledLinkProtyle | null;
}

/** Capture one occurrence before asynchronous title fetching begins. */
export function captureLinkTarget(link: HTMLElement, protyle: any): LinkOccurrenceTarget | null {
  const runner = resolveTitledLinkProtyle(protyle);
  const block = link.closest<HTMLElement>("[data-node-id]");
  const blockID = block?.getAttribute("data-node-id") ?? "";
  const rootID = resolveEditorRootID(protyle) ?? (runner as any)?.block?.rootID ?? (protyle as any)?.block?.rootID ?? (protyle as any)?.rootID;
  const notebook = resolveNotebookID(protyle) ?? (runner as any)?.notebookId ?? (runner as any)?.block?.box ?? (protyle as any)?.notebookId ?? (protyle as any)?.block?.box;
  const href = link.getAttribute("data-href");
  if (!block || !blockID || typeof rootID !== "string" || !rootID ||
      typeof notebook !== "string" || !notebook || typeof href !== "string" || !href) return null;
  const ordinal = linkElements(block).indexOf(link);
  if (ordinal < 0) return null;
  const text = link.textContent ?? "";
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
    originalBlockHTML: block.outerHTML,
    oldPath: href,
    oldValue: text,
  };
}

function isActiveTarget(target: LinkOccurrenceTarget): boolean {
  return Boolean(
    target.protyle &&
    typeof target.protyle.updateTransactionElement === "function" &&
    target.blockElement &&
    target.linkElement &&
    target.blockElement.isConnected &&
    target.linkElement.isConnected &&
    target.linkElement.closest("[data-node-id]") === target.blockElement &&
    target.blockElement.getAttribute("data-node-id") === target.blockID
  );
}

function isLiveOccurrenceValid(target: LinkOccurrenceTarget): boolean {
  const link = target.linkElement;
  if (!link) return false;
  const currentHref = link.getAttribute("data-href");
  const currentText = link.textContent ?? "";
  const currentTitle = link.getAttribute("data-title");
  return currentHref === target.originalHref &&
    currentText === target.originalText &&
    currentTitle === target.originalTitle;
}

function parseBlockFromDOM(html: string, blockID: string): HTMLElement | null {
  if (typeof DOMParser === "undefined") return null;
  const parsed = new DOMParser().parseFromString(html, "text/html");
  const block = [...parsed.querySelectorAll<HTMLElement>("[data-node-id]")]
    .find(element => element.getAttribute("data-node-id") === blockID);
  if (!block || block.querySelector("[data-node-id]")) return null;
  return block;
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

async function awaitCompositionEnd(options: CommitLinkTitleOptions): Promise<boolean> {
  if (!options.isComposing) return true;
  const timeout = options.imeTimeoutMs ?? 3_000;
  const poll = Math.max(1, options.imePollMs ?? 50);
  const deadline = Date.now() + timeout;
  while (options.isComposing()) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) return false;
    if (!await abortAwareDelay(Math.min(poll, remaining), options.signal)) return false;
  }
  return true;
}

async function commitInactiveTitle(
  target: LinkOccurrenceTarget,
  title: string,
  options: CommitLinkTitleOptions,
): Promise<LinkWriteResult> {
  if (!options.kernel) return "conflict";
  try {
    const response = await options.kernel.post<BlockDOM>("/api/block/getBlockDOM", {
      id: target.blockID,
      notebook: target.notebook,
    }, { signal: options.signal });
    if (response?.data?.id !== target.blockID || typeof response?.data?.dom !== "string") {
      return "conflict";
    }
    const block = parseBlockFromDOM(response.data.dom, target.blockID);
    if (!block) return "conflict";

    const links = linkElements(block);
    let link = links[target.ordinal];
    if (!link || link.getAttribute("data-href") !== target.originalHref || (link.textContent ?? "") !== target.originalText) {
      link = links.find(l => l.getAttribute("data-href") === target.originalHref && (l.textContent ?? "") === target.originalText)!;
    }
    if (!link) return "conflict";

    const currentHref = link.getAttribute("data-href");
    const currentText = link.textContent ?? "";
    const currentTitle = link.getAttribute("data-title");
    if (currentHref !== target.originalHref || currentText !== target.originalText || currentTitle !== target.originalTitle) {
      return "conflict";
    }

    const isUnchanged = currentText === title && (!options.replaceTitle || currentTitle === title);
    if (isUnchanged) return "unchanged";

    link.textContent = title;
    if (options.replaceTitle) {
      link.setAttribute("data-title", title);
    }

    const updateRes = await options.kernel.post<{ code?: number }>("/api/block/updateBlock", {
      id: target.blockID,
      dataType: "dom",
      data: block.outerHTML,
    }, { signal: options.signal, timeout: 30_000 });

    if (updateRes && "code" in updateRes && updateRes.code !== undefined && updateRes.code !== 0) {
      return "conflict";
    }
    return "updated";
  } catch (error) {
    if (options.signal?.aborted || (error as { name?: string })?.name === "AbortError") {
      return "aborted";
    }
    return "conflict";
  }
}

async function commitInactiveTitles(
  updates: readonly GroupedLinkTitleUpdate[],
  options: CommitLinkTitleOptions,
): Promise<LinkWriteResult[]> {
  const conflict = () => updates.map(() => "conflict" as LinkWriteResult);
  const aborted = () => updates.map(() => "aborted" as LinkWriteResult);
  if (!options.kernel) return conflict();
  const first = updates[0].target;

  try {
    const response = await options.kernel.post<BlockDOM>("/api/block/getBlockDOM", {
      id: first.blockID,
      notebook: first.notebook,
    }, { signal: options.signal });
    if (response?.data?.id !== first.blockID || typeof response?.data?.dom !== "string") {
      return conflict();
    }
    const block = parseBlockFromDOM(response.data.dom, first.blockID);
    if (!block) return conflict();

    const links = linkElements(block);
    const targetLinks: HTMLElement[] = [];
    for (const { target } of updates) {
      let link = links[target.ordinal];
      if (!link || link.getAttribute("data-href") !== target.originalHref || (link.textContent ?? "") !== target.originalText) {
        link = links.find(l => l.getAttribute("data-href") === target.originalHref && (l.textContent ?? "") === target.originalText)!;
      }
      if (!link || link.getAttribute("data-href") !== target.originalHref ||
          (link.textContent ?? "") !== target.originalText ||
          link.getAttribute("data-title") !== target.originalTitle) {
        return conflict();
      }
      targetLinks.push(link);
    }

    const results = updates.map(({ title }, index) => {
      const link = targetLinks[index];
      return (link.textContent ?? "") === title &&
        (!options.replaceTitle || link.getAttribute("data-title") === title)
        ? ("unchanged" as LinkWriteResult)
        : ("updated" as LinkWriteResult);
    });
    if (!results.some(r => r === "updated")) return results;

    for (let i = 0; i < updates.length; i++) {
      if (results[i] !== "updated") continue;
      const link = targetLinks[i];
      link.textContent = updates[i].title;
      if (options.replaceTitle) {
        link.setAttribute("data-title", updates[i].title);
      }
    }

    const updateRes = await options.kernel.post<{ code?: number }>("/api/block/updateBlock", {
      id: first.blockID,
      dataType: "dom",
      data: block.outerHTML,
    }, { signal: options.signal, timeout: 30_000 });

    if (updateRes && "code" in updateRes && updateRes.code !== undefined && updateRes.code !== 0) {
      return conflict();
    }
    return results;
  } catch (error) {
    if (options.signal?.aborted || (error as { name?: string })?.name === "AbortError") {
      return aborted();
    }
    return conflict();
  }
}

/**
 * Re-read and verify the exact occurrence before mutating the live block.
 * In active Protyle editors:
 * - Live DOM is real-time truth.
 * - Modifies link element text/title in memory DOM and commits via updateTransactionElement.
 * - Supports native Ctrl+Z undo stack.
 * In inactive/background updates:
 * - Reads block DOM, patches link occurrence, posts updateBlock and trusts code: 0.
 */
export async function commitLinkTitle(
  target: LinkOccurrenceTarget,
  title: string,
  options: CommitLinkTitleOptions,
): Promise<LinkWriteResult> {
  if (options.signal?.aborted) return "aborted";
  const leaseKey = `${target.notebook}/${target.blockID}`;
  return withLinkBlockLease(leaseKey, async () => {
    if (options.signal?.aborted) return "aborted";
    if (!await awaitCompositionEnd(options)) return options.signal?.aborted ? "aborted" : "conflict";

    // Inactive or background update path
    if (!isActiveTarget(target)) {
      return commitInactiveTitle(target, title, options);
    }

    // Active Protyle editor path: Live DOM is source of truth
    if (!isLiveOccurrenceValid(target)) return "conflict";

    const link = target.linkElement!;
    const unchanged = (link.textContent ?? "") === title &&
      (!options.replaceTitle || link.getAttribute("data-title") === title);
    if (unchanged) return "unchanged";

    const oldHTML = target.blockElement!.outerHTML;
    const oldText = link.textContent;
    const oldTitle = link.getAttribute("data-title");

    link.textContent = title;
    if (options.replaceTitle) {
      link.setAttribute("data-title", title);
    }

    try {
      await target.protyle!.updateTransactionElement(target.blockElement!, oldHTML);
      return "updated";
    } catch {
      link.textContent = oldText;
      if (oldTitle === null) {
        link.removeAttribute("data-title");
      } else {
        link.setAttribute("data-title", oldTitle);
      }
      return options.signal?.aborted ? "aborted" : "conflict";
    }
  });
}

/**
 * Commit several occurrences from one block in one native transaction or updateBlock call.
 * In active Protyle editors:
 * - All targets in the group are verified against the live DOM and updated in a single
 *   protyle.updateTransactionElement call.
 * In inactive/background updates:
 * - All targets are applied to the fetched block DOM and committed in a single
 *   /api/block/updateBlock call.
 */
export async function commitLinkTitles(
  updates: readonly GroupedLinkTitleUpdate[],
  options: CommitLinkTitleOptions,
): Promise<LinkWriteResult[]> {
  if (updates.length === 0) return [];
  const conflict = () => updates.map(() => "conflict" as LinkWriteResult);
  const aborted = () => updates.map(() => "aborted" as LinkWriteResult);
  if (options.signal?.aborted) return aborted();

  const first = updates[0].target;
  const leaseKey = `${first.notebook}/${first.blockID}`;
  return withLinkBlockLease(leaseKey, async () => {
    if (options.signal?.aborted) return aborted();
    if (!await awaitCompositionEnd(options)) return options.signal?.aborted ? aborted() : conflict();

    if (updates.some(({ target }) =>
      target.notebook !== first.notebook ||
      target.blockID !== first.blockID ||
      target.rootID !== first.rootID ||
      (target.originalBlockHTML !== undefined && first.originalBlockHTML !== undefined && target.originalBlockHTML !== first.originalBlockHTML)
    )) {
      return conflict();
    }

    const duplicateTitles = new Map<string, string>();
    for (const { target, title } of updates) {
      const key = `${target.ordinal}/${target.originalHref}/${target.originalText}`;
      const previous = duplicateTitles.get(key);
      if (previous !== undefined && previous !== title) return conflict();
      duplicateTitles.set(key, title);
    }

    // Inactive or background update path
    if (!isActiveTarget(first)) {
      if (updates.some(({ target }) => isActiveTarget(target))) {
        return conflict();
      }
      return commitInactiveTitles(updates, options);
    }

    // Active Protyle editor path: all targets must belong to the same live block
    if (updates.some(({ target }) =>
      !isActiveTarget(target) ||
      target.blockElement !== first.blockElement ||
      target.protyle !== first.protyle ||
      !isLiveOccurrenceValid(target)
    )) {
      return conflict();
    }

    const results = updates.map(({ target, title }) => {
      const link = target.linkElement!;
      return (link.textContent ?? "") === title &&
        (!options.replaceTitle || link.getAttribute("data-title") === title)
        ? ("unchanged" as LinkWriteResult)
        : ("updated" as LinkWriteResult);
    });
    if (!results.some(result => result === "updated")) return results;

    const oldHTML = first.blockElement!.outerHTML;
    const previousValues = updates.map(({ target }) => ({
      text: target.linkElement!.textContent,
      title: target.linkElement!.getAttribute("data-title"),
    }));

    for (let index = 0; index < updates.length; index += 1) {
      if (results[index] !== "updated") continue;
      const { target, title } = updates[index];
      target.linkElement!.textContent = title;
      if (options.replaceTitle) {
        target.linkElement!.setAttribute("data-title", title);
      }
    }

    try {
      await first.protyle!.updateTransactionElement(first.blockElement!, oldHTML);
      return results;
    } catch {
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
      }
      return updates.map(() => options.signal?.aborted ? "aborted" : "conflict");
    }
  });
}
