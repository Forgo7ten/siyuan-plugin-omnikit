import { isInsideProtectedContainer } from "../../../core/host/dom.ts";
import { imageSourceAttribute, trySource, type ImageSource } from "../policy/source.ts";
import type { ImageConfig } from "../policy/parseImageConfig.ts";
import { classifyImageCandidate } from "../policy/ImageCandidateClassifier.ts";

export interface DocumentImageOccurrence { blockId: string; imageOrdinal: number; source: ImageSource }

export interface DocumentImageScanResult {
  occurrences: DocumentImageOccurrence[];
  scannedBlocks: number;
  nestedBlockIds: Set<string>;
}

/** 扫描内核返回的整篇文档 DOM（包含折叠与未挂载块），跳过嵌套块与受保护容器。 */
export function scanDocumentImages(dom: string, origin: string, config: ImageConfig): DocumentImageScanResult {
  const parsed = new DOMParser().parseFromString(dom, "text/html");
  const blocks = Array.from(parsed.querySelectorAll("[data-node-id]"));
  const occurrences: DocumentImageOccurrence[] = [];
  const ordinals = new Map<string, number>();
  const checkedBlocks = new Set<string>();
  const nestedBlockIds = new Set<string>();
  for (const image of Array.from(parsed.querySelectorAll("img"))) {
    const owner = image.closest("[data-node-id]");
    const blockId = owner?.getAttribute("data-node-id");
    const imageOrdinal = blockId ? ordinals.get(blockId) ?? 0 : 0;
    if (blockId) ordinals.set(blockId, imageOrdinal + 1);
    if (isInsideProtectedContainer(image)) continue;
    const raw = imageSourceAttribute(image);
    const source = raw && trySource(raw, origin);
    if (!source || !blockId) continue;
    const decision = classifyImageCandidate({
      path: source.raw,
      mode: "document",
      excludedExtensions: config.compression.excludedExtensions,
      smartEnabled: config.compression.smartEnabled === true,
    });
    if (!decision.eligible) continue;
    if (owner && typeof (owner as Element).querySelector === "function" && !checkedBlocks.has(blockId)) {
      checkedBlocks.add(blockId);
      if (owner.querySelector("[data-node-id]")) {
        nestedBlockIds.add(blockId);
      }
    }
    occurrences.push({ blockId, imageOrdinal, source });
  }
  return { occurrences, scannedBlocks: blocks.length, nestedBlockIds };
}
