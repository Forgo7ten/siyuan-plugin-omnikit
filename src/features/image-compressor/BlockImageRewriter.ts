import { imageReferenceParser } from "./ImageReferenceParser.ts";
import { BlockActionCoordinator } from "./BlockActionCoordinator.ts";

export interface ImageBlockRepository {
  getBlockDOM(id: string): Promise<string>;
  updateBlockDOM(id: string, dom: string, signal?: AbortSignal): Promise<void>;
}
export type BlockRewriteResult = "updated" | "conflict" | "cancelled";

/**
 * @safety Re-reads the block before and after the rewrite and commits at most once per block,
 * so a concurrent edit is reported as a conflict instead of being overwritten.
 */
export async function rewriteImageBlockOnce(
  repository: ImageBlockRepository,
  blockID: string,
  replacements: Map<string, { nextURL: string; expectedCount: number }>,
  signal?: AbortSignal,
  coordinator?: BlockActionCoordinator,
): Promise<BlockRewriteResult> {
  if (coordinator) return coordinator.run(blockID, () => rewriteImageBlockOnce(repository, blockID, replacements, signal));
  if (signal?.aborted) return "cancelled";
  const observed = await repository.getBlockDOM(blockID);
  if (signal?.aborted) return "cancelled";
  if (!imageReferenceParser.replaceMany(observed, blockID, replacements).ok) return "conflict";
  const latest = await repository.getBlockDOM(blockID);
  if (signal?.aborted) return "cancelled";
  // The kernel update endpoint has no compare-and-swap. Detect edits observed between our reads,
  // while acknowledging that an external edit can still race after this check.
  if (latest !== observed) return "conflict";
  const rewrite = imageReferenceParser.replaceMany(latest, blockID, replacements);
  if (!rewrite.ok) return "conflict";
  if (signal?.aborted) return "cancelled";
  await repository.updateBlockDOM(blockID, rewrite.markdown, signal);
  return "updated";
}
