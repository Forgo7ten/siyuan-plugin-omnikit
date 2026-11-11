/**
 * @design Progress and per-item outcomes live in one module so the batch action, the dialog
 * and future consumers share a single contract without importing the action itself.
 */
export interface CompressionProgress {
  total: number;
  completed: number;
  succeeded: number;
  skipped: number;
  failed: number;
  conflicts: number;
  cancelled: boolean;
  originalBytes: number;
  compressedBytes: number;
  savedBytes: number;
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
