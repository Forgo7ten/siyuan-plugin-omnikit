/**
 * @design Progress and per-item outcomes live in one module so the batch action, the dialog
 * and future consumers share a single contract without importing the action itself.
 */
export interface CompressionProgress {
  scanComplete: boolean;
  scannedBlocks: number;
  total: number;
  completed: number;
  succeeded: number;
  skipped: number;
  failed: number;
  conflicts: number;
  cancelled: boolean;
  originalBytes: number;
  compressedBytes: number;
  referencesRewritten: number;
  originalReferencedBytes: number;
  newReferencedBytes: number;
  logicalReductionBytes: number;
  diskReclaimedBytes: number;
  currentFile?: string;
}

export type CompressionBatchSummary = Omit<CompressionProgress, "currentFile">;

export type CompressionItemState = "success" | "skipped" | "failed";

export interface CompressionItemResult {
  path: string;
  next?: string;
  state: CompressionItemState;
  originalBytes: number;
  compressedBytes: number;
}

/** Records one successfully rewritten reference and counts resource size once per source path. */
export function recordRewrittenReference(
  summary: Pick<CompressionBatchSummary, "referencesRewritten" | "succeeded" | "originalReferencedBytes" | "newReferencedBytes" | "logicalReductionBytes">,
  path: string,
  originalBytes: number,
  newBytes: number,
  countedPaths: Set<string>,
): void {
  summary.referencesRewritten++;
  summary.succeeded++;
  if (countedPaths.has(path)) return;
  countedPaths.add(path);
  summary.originalReferencedBytes += originalBytes;
  summary.newReferencedBytes += newBytes;
  summary.logicalReductionBytes += Math.max(0, originalBytes - newBytes);
}
