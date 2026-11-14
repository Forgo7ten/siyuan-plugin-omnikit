import { imageSourceAttribute, trySource, type ImageSource } from "./source.ts";
import type { ImageConfig } from "./parseImageConfig.ts";

export interface DocumentImageOccurrence { blockId: string; imageOrdinal: number; source: ImageSource }

/** Scan the complete DOM returned by the kernel, including folded and unmounted blocks. */
export function scanDocumentImages(dom: string, origin: string, config: ImageConfig): { occurrences: DocumentImageOccurrence[]; scannedBlocks: number } {
  const parsed = new DOMParser().parseFromString(dom, "text/html");
  if (parsed.querySelector("parsererror")) throw new Error("Unable to parse document DOM");
  const blocks = Array.from(parsed.querySelectorAll("[data-node-id]"));
  const occurrences: DocumentImageOccurrence[] = [];
  const ordinals = new Map<string, number>();
  for (const image of Array.from(parsed.querySelectorAll("img"))) {
    const blockId = image.closest("[data-node-id]")?.getAttribute("data-node-id");
    const imageOrdinal = blockId ? ordinals.get(blockId) ?? 0 : 0;
    if (blockId) ordinals.set(blockId, imageOrdinal + 1);
    if (image.closest("pre, code, script, style, [data-type='NodeCodeBlock'], [data-type='NodeBlockQueryEmbed']")) continue;
    const raw = imageSourceAttribute(image);
    const source = raw && trySource(raw, origin);
    if (source && !blockId) throw new Error("Image has no owning block");
    if (!source || !blockId) continue;
    const extension = source.name.split(".").pop()?.toLowerCase() ?? "";
    if (["gif", "svg", "webp"].includes(extension) || config.compression.excludedExtensions.includes(extension) ||
      source.name.toLowerCase().includes("excalidraw")) continue;
    occurrences.push({ blockId, imageOrdinal, source });
  }
  return { occurrences, scannedBlocks: blocks.length };
}
