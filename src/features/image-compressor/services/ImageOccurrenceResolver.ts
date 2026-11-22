import type { KernelClient } from "../../../core/host/KernelClient.ts";
import type { OccurrenceTarget } from "../policy/contracts.ts";
import { parseSingleLeafBlock } from "../policy/dom.ts";
import { imageSourceAttribute } from "../policy/source.ts";

export interface ImageOccurrenceEvidence {
  rootID: string;
  notebook: string;
  blockID: string;
  imageOrdinal: number;
  oldPath: string;
}

/** 根据已捕获的块内位置证据，校验目标块无嵌套且序号节点路径仍与 oldPath 一致。 */
export function resolveImageOccurrence(
  blockDOM: string,
  evidence: ImageOccurrenceEvidence,
): OccurrenceTarget | undefined {
  if (!Number.isSafeInteger(evidence.imageOrdinal) || evidence.imageOrdinal < 0) return undefined;
  const root = parseSingleLeafBlock(blockDOM, evidence.blockID);
  if (!root) return undefined;
  const images = [...root.querySelectorAll("img")];
  const selected = images[evidence.imageOrdinal];
  if (!selected || imageSourceAttribute(selected) !== evidence.oldPath) return undefined;
  return { ...evidence };
}

/** Waits for a specific observed position to appear in the persisted block; ambiguity is a skip. */
export async function waitForPersistedImageOccurrence(
  kernel: KernelClient,
  evidence: ImageOccurrenceEvidence,
  attempts = 2,
  signal?: AbortSignal,
): Promise<OccurrenceTarget | undefined> {
  for (let attempt = 0; attempt < attempts; attempt++) {
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
    if (attempt + 1 < attempts) await new Promise(resolve => setTimeout(resolve, 50));
  }
  return undefined;
}
