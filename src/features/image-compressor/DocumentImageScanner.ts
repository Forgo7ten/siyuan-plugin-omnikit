import { originalAssetURL } from "./OriginalAssetURL.ts";
import { isEligibleImage } from "./ImageEligibility.ts";
import type { ImageSettings } from "./settings.ts";

export interface DocumentImageOccurrence { blockId: string; source: string; }
export interface DocumentImageScan { occurrences: DocumentImageOccurrence[]; scannedBlocks: number; }

/**
 * SiYuan's getBlockDOM renders the loaded root AST with cleanRenderNode(node, false).
 * In the kernel, false means `visibleOnly=false`, so folded and non-visible descendants
 * remain in the returned nested DOM. `closest(data-node-id)` assigns each image to its
 * innermost block, avoiding counting a container's rendered children again as its own.
 */
export function scanDocumentImageDOM(dom: string, settings: ImageSettings): DocumentImageScan {
  if (!dom.trim()) throw new Error("SiYuan returned an empty document DOM");
  const parsed = new DOMParser().parseFromString(dom, "text/html");
  if (parsed.querySelector("parsererror")) throw new Error("Unable to parse document DOM");
  const blocks = Array.from(parsed.querySelectorAll("[data-node-id]"));
  const occurrences: DocumentImageOccurrence[] = [];
  for (const image of Array.from(parsed.querySelectorAll("img"))) {
    const blockId = image.closest("[data-node-id]")?.getAttribute("data-node-id");
    const source = originalAssetURL(image);
    if (source && !blockId) throw new Error("Image has no owning block");
    if (blockId && source && !/excalidraw/i.test(source) && isEligibleImage(source, "", settings)) {
      occurrences.push({ blockId, source });
    }
  }
  return { occurrences, scannedBlocks: blocks.length };
}
