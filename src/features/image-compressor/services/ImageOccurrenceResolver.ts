import type { KernelClient } from "../../../core/host/KernelClient.ts";
import type { OccurrenceTarget } from "../policy/contracts.ts";

export interface ImageOccurrenceEvidence {
  rootID: string;
  notebook: string;
  blockID: string;
  imageOrdinal: number;
  oldPath: string;
}

/** Resolves an explicitly observed image position against one persisted owner block. */
export function resolveImageOccurrence(
  blockDOM: string,
  evidence: ImageOccurrenceEvidence,
): OccurrenceTarget | undefined {
  if (!blockDOM.trim() || !Number.isSafeInteger(evidence.imageOrdinal) || evidence.imageOrdinal < 0) return undefined;
  const template = document.createElement("template");
  template.innerHTML = blockDOM;
  const roots = [...template.content.children].filter(element => element.getAttribute("data-node-id") === evidence.blockID);
  if (template.content.children.length !== 1 || roots.length !== 1 || roots[0].querySelector("[data-node-id]")) return undefined;
  const images = [...roots[0].querySelectorAll("img")];
  const selected = images[evidence.imageOrdinal];
  if (!selected || imagePath(selected) !== evidence.oldPath) return undefined;
  return { ...evidence, baselineBlockDOM: blockDOM };
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
        if (target) {
          const info = await kernel.post<{ rootID: string; box?: string }>("/api/block/getBlockInfo", {
            id: evidence.blockID, notebook: evidence.notebook,
          }, { signal });
          if (info.data?.rootID === evidence.rootID && info.data.box === evidence.notebook) return target;
          return undefined;
        }
      }
    } catch {
      if (signal?.aborted) return undefined;
    }
    if (attempt + 1 < attempts) await new Promise(resolve => setTimeout(resolve, 50));
  }
  return undefined;
}

export function imagePath(image: Element): string | null {
  return image.hasAttribute("data-src") ? image.getAttribute("data-src") : image.getAttribute("src");
}
