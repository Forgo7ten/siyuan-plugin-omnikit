import type { KernelClient } from "../../../core/host/KernelClient.ts";
import type { OccurrenceTarget } from "../policy/contracts.ts";
import { parseSingleLeafBlock } from "../policy/dom.ts";
import { buildReplacementPath, imageSourceAttribute } from "../policy/source.ts";
import { blockDOM } from "./SafeBlockWriter.ts";

export interface ImageOccurrenceEvidence {
  rootID: string;
  notebook: string;
  blockID: string;
  imageOrdinal: number;
  oldPath: string;
}

export const DEFAULT_PERSISTENCE_RETRY_DELAYS_MS: readonly number[] = [60, 100, 160, 250, 400, 600];

function waitWithAbort(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted || ms <= 0) return Promise.resolve();
  return new Promise(resolve => {
    const onAbort = () => {
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/** 根据已捕获的块内位置证据，校验目标块无嵌套且序号节点路径仍与 oldPath 一致。 */
export function resolveImageOccurrence(
  dom: string,
  evidence: ImageOccurrenceEvidence,
): OccurrenceTarget | undefined {
  if (!Number.isSafeInteger(evidence.imageOrdinal) || evidence.imageOrdinal < 0) return undefined;
  const root = parseSingleLeafBlock(dom, evidence.blockID);
  if (!root) return undefined;
  const images = [...root.querySelectorAll("img")];
  const selected = images[evidence.imageOrdinal];
  if (!selected || imageSourceAttribute(selected) !== evidence.oldPath) return undefined;
  return { ...evidence };
}

/**
 * 本地化替换完成后通过内核重读目标块，核验单块无嵌套且目标序号节点已更新为预期本地路径，
 * 并构造新的 `OccurrenceTarget` 供后续 WebP 压缩改写使用。
 */
export async function recaptureReplacedImageOccurrence(
  kernel: KernelClient,
  previous: OccurrenceTarget,
  newPath: string,
  origin: string,
  signal?: AbortSignal,
): Promise<OccurrenceTarget | undefined> {
  const expectedOldPath = buildReplacementPath(previous.oldPath, newPath, origin);
  const freshDOM = await blockDOM(kernel, previous.blockID, previous.notebook, signal);
  return resolveImageOccurrence(freshDOM, {
    rootID: previous.rootID,
    notebook: previous.notebook,
    blockID: previous.blockID,
    imageOrdinal: previous.imageOrdinal,
    oldPath: expectedOldPath,
  });
}

/** Waits for a specific observed position to appear in the persisted block; ambiguity is a skip. */
export async function waitForPersistedImageOccurrence(
  kernel: KernelClient,
  evidence: ImageOccurrenceEvidence,
  attemptsOrDelays: number | readonly number[] = DEFAULT_PERSISTENCE_RETRY_DELAYS_MS,
  signal?: AbortSignal,
): Promise<OccurrenceTarget | undefined> {
  const delays: readonly number[] = typeof attemptsOrDelays === "number"
    ? Array.from({ length: Math.max(0, Math.trunc(attemptsOrDelays) - 1) }, () => 50)
    : attemptsOrDelays;
  const totalAttempts = typeof attemptsOrDelays === "number"
    ? Math.max(0, Math.trunc(attemptsOrDelays))
    : delays.length + 1;

  for (let attempt = 0; attempt < totalAttempts; attempt++) {
    if (signal?.aborted) return undefined;
    try {
      const response = await kernel.post<{ id: string; dom: string }>("/api/block/getBlockDOM", {
        id: evidence.blockID, notebook: evidence.notebook,
      }, { signal });
      if (response.data?.id === evidence.blockID && typeof response.data.dom === "string") {
        const target = resolveImageOccurrence(response.data.dom, evidence);
        if (target) return target;
      }
    } catch {
      if (signal?.aborted) return undefined;
    }
    if (attempt < delays.length) {
      await waitWithAbort(delays[attempt], signal);
    }
  }
  return undefined;
}
