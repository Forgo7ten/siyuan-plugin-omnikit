import type { LinkActionResult } from "../policy/types.ts";
import { isAbortError } from "../../../core/feedback/UiFeedback.ts";
import { isInsideProtectedContainer } from "../../../core/host/dom.ts";
import { getKernelOutcome } from "../../../core/host/kernelOutcome.ts";
import { Logger } from "../../../core/host/Logger.ts";
import {
  isUpdateCurrent,
  linkElements,
  mapUpdatesByCurrent,
  normalizeBlockForComparison,
  parseBlockFromDOM,
  stripRenderOnlyAttributes,
  type CommitLinkTitleOptions,
  type GroupedLinkTitleUpdate,
} from "./block-dom-snapshot.ts";

interface BlockDOM {
  id?: string;
  dom?: string;
}

interface BlockInfo {
  rootID?: string;
  box?: string;
}

export async function commitInactiveTitles(
  updates: readonly GroupedLinkTitleUpdate[],
  options: CommitLinkTitleOptions,
): Promise<LinkActionResult[]> {
  const conflict = () => mapUpdatesByCurrent(updates, options, "conflict");
  const failed = () => mapUpdatesByCurrent(updates, options, "failed");
  const unknown = () => mapUpdatesByCurrent(updates, options, "unknown");
  const aborted = () => updates.map((): LinkActionResult => "aborted");
  if (!options.kernel) return failed();
  const first = updates[0].target;

  let results: LinkActionResult[];
  let expectedHTML: string;
  try {
    const infoRes = await options.kernel.post<BlockInfo>(
      "/api/block/getBlockInfo",
      {
        id: first.blockID,
        ...(first.notebook ? { notebook: first.notebook } : {}),
      },
      { signal: options.signal, timeout: 30_000 },
    );
    if (
      !infoRes?.data ||
      typeof infoRes.data.rootID !== "string" ||
      !infoRes.data.rootID ||
      (first.notebook && (typeof infoRes.data.box !== "string" || !infoRes.data.box))
    ) {
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
      return updates.map((): LinkActionResult => "superseded");
    }

    const response = await options.kernel.post<BlockDOM>(
      "/api/block/getBlockDOM",
      {
        id: first.blockID,
        notebook: first.notebook,
      },
      { signal: options.signal },
    );
    if (response?.data?.id !== first.blockID || typeof response?.data?.dom !== "string" || !response.data.dom) {
      return failed();
    }
    const activeFlags = updates.map(u => isUpdateCurrent(u, options));
    if (!activeFlags.some(Boolean)) {
      return updates.map((): LinkActionResult => "superseded");
    }
    const block = parseBlockFromDOM(response.data.dom, first.blockID);
    if (!block) return failed();
    stripRenderOnlyAttributes(block);
    if (first.originalBlockHTML !== undefined) {
      const baseline = parseBlockFromDOM(first.originalBlockHTML, first.blockID);
      if (!baseline) return failed();
      if (normalizeBlockForComparison(baseline) !== normalizeBlockForComparison(block)) {
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
      if (
        !link ||
        isInsideProtectedContainer(link) ||
        link.getAttribute("data-href") !== target.originalHref ||
        (link.textContent ?? "") !== target.originalText ||
        link.getAttribute("data-title") !== target.originalTitle
      ) {
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

  const mapPostResults = (activeValue: LinkActionResult): LinkActionResult[] =>
    results.map((result, index) =>
      result === "superseded" || !isUpdateCurrent(updates[index], options) ? "superseded" : activeValue,
    );

  try {
    await options.kernel.post(
      "/api/block/updateBlock",
      {
        id: first.blockID,
        dataType: "dom",
        data: expectedHTML,
        lockType: true,
      },
      { signal: options.signal, timeout: 30_000 },
    );
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
      const verifyRes = await options.kernel.post<BlockDOM>(
        "/api/block/getBlockDOM",
        {
          id: first.blockID,
          notebook: first.notebook,
        },
        { signal: options.signal, timeout: 10_000 },
      );
      if (verifyRes?.data?.id !== first.blockID || typeof verifyRes?.data?.dom !== "string" || !verifyRes.data.dom) {
        return mapPostResults("unknown");
      }
      const latestBlock = parseBlockFromDOM(verifyRes.data.dom, first.blockID);
      const expectedBlock = parseBlockFromDOM(expectedHTML, first.blockID);
      if (!latestBlock || !expectedBlock) return mapPostResults("unknown");
      const latestNormalized = normalizeBlockForComparison(latestBlock);
      if (latestNormalized === normalizeBlockForComparison(expectedBlock)) {
        Logger.shared.debug("unknown 重读核验确认已落盘", { blockID: first.blockID });
        return results;
      }

      if (first.originalBlockHTML !== undefined) {
        const baselineBlock = parseBlockFromDOM(first.originalBlockHTML, first.blockID);
        if (baselineBlock && latestNormalized === normalizeBlockForComparison(baselineBlock)) {
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
      Logger.shared.debug("unknown 重读核验发现并发变更，判定冲突", { blockID: first.blockID });
      return mapPostResults("conflict");
    } catch (verifyError) {
      Logger.shared.debug("unknown 重读核验请求异常", { blockID: first.blockID, verifyError });
      return mapPostResults("unknown");
    }
  }
}
