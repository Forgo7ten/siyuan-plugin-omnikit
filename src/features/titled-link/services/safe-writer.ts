import type { LinkOccurrenceTarget, TitledLinkProtyle } from "../types.ts";

export type LinkWriteResult = "updated" | "unchanged" | "conflict" | "aborted";

export interface LinkWriterKernel {
  post<T>(path: string, body: unknown, options?: { signal?: AbortSignal; timeout?: number }): Promise<{ data: T }>;
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

interface BlockIdentity { rootID?: string; box?: string }
interface BlockDOM { id?: string; dom?: string }

const blockTails = new Map<string, Promise<void>>();
const trustedLiveSnapshots = new WeakMap<HTMLElement, string>();

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
  if (typeof protyle?.updateTransactionElement === "function") {
    return protyle as TitledLinkProtyle;
  }
  if (typeof protyle?.getInstance === "function") {
    const instance = protyle.getInstance();
    if (typeof instance?.updateTransactionElement === "function") {
      return instance as TitledLinkProtyle;
    }
  }
  if (typeof protyle?.protyle?.updateTransactionElement === "function") {
    return protyle.protyle as TitledLinkProtyle;
  }
  return null;
}

/** Capture one occurrence before asynchronous title fetching begins. */
export function captureLinkTarget(link: HTMLElement, protyle: any): LinkOccurrenceTarget | null {
  const runner = resolveTitledLinkProtyle(protyle);
  if (!runner) return null;
  const block = link.closest<HTMLElement>("[data-node-id]");
  const blockID = block?.getAttribute("data-node-id") ?? "";
  const rootID = protyle?.block?.rootID ?? protyle?.protyle?.block?.rootID ?? (runner as any)?.block?.rootID;
  const notebook = protyle?.notebookId ?? protyle?.block?.box ?? protyle?.protyle?.notebookId ?? protyle?.protyle?.block?.box ?? (runner as any)?.notebookId ?? (runner as any)?.block?.box;
  const href = link.getAttribute("data-href");
  if (!block || !blockID || typeof rootID !== "string" || !rootID ||
      typeof notebook !== "string" || !notebook || typeof href !== "string" || !href) return null;
  const ordinal = linkElements(block).indexOf(link);
  if (ordinal < 0) return null;
  const text = link.textContent ?? "";
  return {
    protyle: runner,
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

function occurrenceUnchanged(target: LinkOccurrenceTarget): boolean {
  const { blockElement: block, linkElement: link } = target;
  if (!block.isConnected || !link.isConnected || link.closest("[data-node-id]") !== block) return false;
  if (block.getAttribute("data-node-id") !== target.blockID) return false;
  if (linkElements(block)[target.ordinal] !== link) return false;
  return link.getAttribute("data-href") === target.originalHref &&
    (link.textContent ?? "") === target.originalText &&
    link.getAttribute("data-title") === target.originalTitle;
}

function liveBlockUnchanged(target: LinkOccurrenceTarget): boolean {
  const current = target.blockElement.outerHTML;
  return current === target.originalBlockHTML || current === trustedLiveSnapshots.get(target.blockElement);
}

function persistedOccurrence(dom: string, target: LinkOccurrenceTarget): HTMLElement | undefined {
  if (typeof DOMParser === "undefined") return undefined;
  const parsed = new DOMParser().parseFromString(dom, "text/html");
  const block = [...parsed.querySelectorAll<HTMLElement>("[data-node-id]")]
    .find(element => element.getAttribute("data-node-id") === target.blockID);
  if (!block || block.querySelector("[data-node-id]")) return undefined;
  return linkElements(block)[target.ordinal];
}

async function verifyPersisted(target: LinkOccurrenceTarget, kernel: LinkWriterKernel, signal?: AbortSignal): Promise<boolean> {
  try {
    const blockHTML = await readPersistedBlock(target, kernel, signal);
    return blockHTML !== null && persistedOccurrenceUnchanged(blockHTML, target);
  } catch (error) {
    if (signal?.aborted || (error as { name?: string })?.name === "AbortError") throw error;
    return false;
  }
}

/** Read the persisted block once; callers can then verify every occurrence in it. */
async function readPersistedBlock(
  target: LinkOccurrenceTarget,
  kernel: LinkWriterKernel,
  signal?: AbortSignal,
): Promise<string | null> {
  try {
    const identity = await kernel.post<BlockIdentity>("/api/block/getBlockInfo", {
      id: target.blockID,
      notebook: target.notebook,
    }, { signal });
    if (identity?.data?.rootID !== target.rootID || identity?.data?.box !== target.notebook) return null;
    const response = await kernel.post<BlockDOM>("/api/block/getBlockDOM", {
      id: target.blockID,
      notebook: target.notebook,
    }, { signal });
    if (response?.data?.id !== target.blockID || typeof response?.data?.dom !== "string") return null;
    return response.data.dom;
  } catch (error) {
    if (signal?.aborted || (error as { name?: string })?.name === "AbortError") throw error;
    return null;
  }
}

function persistedOccurrenceUnchanged(dom: string, target: LinkOccurrenceTarget): boolean {
  const link = persistedOccurrence(dom, target);
  return Boolean(link && link.getAttribute("data-href") === target.originalHref &&
    (link.textContent ?? "") === target.originalText &&
    link.getAttribute("data-title") === target.originalTitle);
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

/**
 * Re-read and verify the exact occurrence before mutating the live block. The old HTML is
 * captured only after host menu settlement, immediately before the transaction submission.
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
    if (!occurrenceUnchanged(target) || !liveBlockUnchanged(target)) return "conflict";
    try {
      if (options.kernel && !await verifyPersisted(target, options.kernel, options.signal)) return "conflict";
    } catch (error) {
      if (options.signal?.aborted || (error as { name?: string })?.name === "AbortError") return "aborted";
      return "conflict";
    }
    if (options.signal?.aborted || !occurrenceUnchanged(target) || !liveBlockUnchanged(target)) {
      return options.signal?.aborted ? "aborted" : "conflict";
    }

    const link = target.linkElement;
    const unchanged = (link.textContent ?? "") === title &&
      (!options.replaceTitle || link.getAttribute("data-title") === title);
    if (unchanged) return "unchanged";

    const oldHTML = target.blockElement.outerHTML;
    const oldText = link.textContent;
    const oldTitle = link.getAttribute("data-title");
    link.textContent = title;
    if (options.replaceTitle) link.setAttribute("data-title", title);
    try {
      await target.protyle.updateTransactionElement(target.blockElement, oldHTML);
      trustedLiveSnapshots.set(target.blockElement, target.blockElement.outerHTML);
      return "updated";
    } catch {
      link.textContent = oldText;
      if (oldTitle === null) link.removeAttribute("data-title");
      else link.setAttribute("data-title", oldTitle);
      return options.signal?.aborted ? "aborted" : "conflict";
    }
  });
}

/**
 * Commit several occurrences from one block in one native transaction.
 *
 * The persisted block is read once under the block lease and every target is
 * checked against that same snapshot. A persisted/live conflict aborts the
 * whole group: updateTransactionElement writes the complete block, so a
 * partial commit could otherwise overwrite an external change in another
 * occurrence. Titles which are already current are reported as unchanged and
 * are not touched.
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

    // A grouped writer is deliberately single-block. Reject malformed or
    // mixed groups rather than silently acquiring only the first block lease.
    if (updates.some(({ target }) => target.notebook !== first.notebook ||
      target.blockID !== first.blockID || target.rootID !== first.rootID ||
      target.blockElement !== first.blockElement || target.protyle !== first.protyle ||
      target.originalBlockHTML !== first.originalBlockHTML)) {
      return conflict();
    }
    const duplicateTitles = new Map<string, string>();
    for (const { target, title } of updates) {
      const key = `${target.ordinal}/${target.originalHref}/${target.originalText}`;
      const previous = duplicateTitles.get(key);
      if (previous !== undefined && previous !== title) return conflict();
      duplicateTitles.set(key, title);
    }

    // The block-level snapshot check protects against local, not-yet-persisted
    // typing. Occurrence checks additionally protect the exact occurrence.
    if (updates.some(({ target }) => !liveBlockUnchanged(target) || !occurrenceUnchanged(target))) {
      return conflict();
    }

    try {
      if (options.kernel) {
        const persistedHTML = await readPersistedBlock(first, options.kernel, options.signal);
        if (persistedHTML === null || updates.some(({ target }) => !persistedOccurrenceUnchanged(persistedHTML, target))) {
          return conflict();
        }
      }
    } catch (error) {
      if (options.signal?.aborted || (error as { name?: string })?.name === "AbortError") return aborted();
      return conflict();
    }

    if (options.signal?.aborted || updates.some(({ target }) => !liveBlockUnchanged(target) || !occurrenceUnchanged(target))) {
      return options.signal?.aborted ? aborted() : conflict();
    }

    const results = updates.map(({ target, title }) => {
      const link = target.linkElement;
      return (link.textContent ?? "") === title &&
        (!options.replaceTitle || link.getAttribute("data-title") === title)
        ? "unchanged" as LinkWriteResult
        : "updated" as LinkWriteResult;
    });
    if (!results.some(result => result === "updated")) return results;

    const oldHTML = first.blockElement.outerHTML;
    const previousValues = updates.map(({ target }) => ({
      text: target.linkElement.textContent,
      title: target.linkElement.getAttribute("data-title"),
    }));
    for (let index = 0; index < updates.length; index += 1) {
      if (results[index] !== "updated") continue;
      const { target, title } = updates[index];
      target.linkElement.textContent = title;
      if (options.replaceTitle) target.linkElement.setAttribute("data-title", title);
    }
    try {
      await first.protyle.updateTransactionElement(first.blockElement, oldHTML);
      trustedLiveSnapshots.set(first.blockElement, first.blockElement.outerHTML);
      return results;
    } catch {
      for (let index = 0; index < updates.length; index += 1) {
        if (results[index] !== "updated") continue;
        const { target } = updates[index];
        target.linkElement.textContent = previousValues[index].text;
        const oldTitle = previousValues[index].title;
        if (oldTitle === null) target.linkElement.removeAttribute("data-title");
        else target.linkElement.setAttribute("data-title", oldTitle);
      }
      return updates.map(() => options.signal?.aborted ? "aborted" : "conflict");
    }
  });
}
