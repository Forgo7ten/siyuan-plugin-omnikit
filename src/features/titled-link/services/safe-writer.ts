import type { LinkActionResult, LinkOccurrenceTarget } from "../policy/types.ts";
import { isAbortError } from "../../../core/feedback/UiFeedback.ts";
import { withBlockWriteLease } from "../../../core/host/BlockWriteLease.ts";
import { Logger } from "../../../core/host/Logger.ts";
import { isProtyleReadOnly } from "../../../core/host/ProtyleAdapter.ts";
import { commitActiveTitles, isActiveEditor } from "./active-editor-writer.ts";
import {
  captureLinkTarget,
  isUpdateCurrent,
  mapUpdatesByCurrent,
  normalizeBlockForComparison,
  type CommitLinkTitleOptions,
  type GroupedLinkTitleUpdate,
  type LinkWriterKernel,
} from "./block-dom-snapshot.ts";
import { commitInactiveTitles } from "./inactive-block-writer.ts";

export { captureLinkTarget, normalizeBlockForComparison };
export type { CommitLinkTitleOptions, GroupedLinkTitleUpdate, LinkWriterKernel };

export const DEFAULT_IME_TIMEOUT_MS = 5_000;
export const DEFAULT_IME_POLL_MS = 500;

function abortAwareDelay(ms: number, signal?: AbortSignal): Promise<boolean> {
  if (signal?.aborted) return Promise.resolve(false);
  return new Promise(resolve => {
    const timer = setTimeout(() => {
      cleanup();
      resolve(true);
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      cleanup();
      resolve(false);
    };
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
    if (!(await abortAwareDelay(Math.min(poll, remaining), options.signal))) return false;
  }
  return true;
}

/**
 * Re-read and verify the exact occurrence before mutating the live block.
 */
export async function commitLinkTitle(
  target: LinkOccurrenceTarget,
  title: string,
  options: CommitLinkTitleOptions,
): Promise<LinkActionResult> {
  const [result] = await commitLinkTitles([{ target, title, isCurrent: options.isCurrent }], options);
  return result ?? "conflict";
}

/**
 * Commit several occurrences from one block in one native transaction or updateBlock call.
 */
export async function commitLinkTitles(
  updates: readonly GroupedLinkTitleUpdate[],
  options: CommitLinkTitleOptions,
): Promise<LinkActionResult[]> {
  if (updates.length === 0) return [];
  const conflict = () => mapUpdatesByCurrent(updates, options, "conflict");
  const aborted = () => updates.map((): LinkActionResult => "aborted");
  if (options.signal?.aborted) return aborted();

  const first = updates[0].target;
  try {
    return await withBlockWriteLease(first.notebook, first.blockID, options.signal, async () => {
      if (updates.every(u => !isUpdateCurrent(u, options))) {
        return updates.map((): LinkActionResult => "superseded");
      }
      if (isActiveEditor(first) && !isProtyleReadOnly(first.protyle, first.blockElement)) {
        if (!(await awaitCompositionEnd(options, first.protyle, () => isActiveEditor(first)))) {
          const outcome = options.signal?.aborted ? "aborted" : "ime-timeout";
          Logger.shared.debug("等待 IME 输入结束未通过，跳过标题写入", { blockID: first.blockID, outcome });
          return options.signal?.aborted ? aborted() : mapUpdatesByCurrent(updates, options, "ime-timeout");
        }
      }
      const activeFlags = updates.map(u => isUpdateCurrent(u, options));
      if (!activeFlags.some(Boolean)) {
        return updates.map((): LinkActionResult => "superseded");
      }

      if (
        updates.some(
          ({ target }) =>
            target.notebook !== first.notebook ||
            target.blockID !== first.blockID ||
            target.rootID !== first.rootID ||
            (target.originalBlockHTML !== undefined &&
              first.originalBlockHTML !== undefined &&
              target.originalBlockHTML !== first.originalBlockHTML),
        )
      ) {
        return conflict();
      }

      const ordinals = new Set<number>();
      for (let i = 0; i < updates.length; i++) {
        if (!activeFlags[i]) continue;
        if (ordinals.has(updates[i].target.ordinal)) return conflict();
        ordinals.add(updates[i].target.ordinal);
      }

      if (!isActiveEditor(first)) {
        if (updates.some(({ target }) => isActiveEditor(target))) {
          Logger.shared.debug("块内写组活跃编辑器状态不一致，判定冲突", { blockID: first.blockID });
          return conflict();
        }
        Logger.shared.debug("原编辑器已关闭或不可用，切换为后台 updateBlock 写入路径", { blockID: first.blockID });
        return commitInactiveTitles(updates, options);
      }

      return commitActiveTitles(updates, activeFlags, options);
    });
  } catch (error) {
    if (options.signal?.aborted || isAbortError(error)) {
      return aborted();
    }
    throw error;
  }
}
