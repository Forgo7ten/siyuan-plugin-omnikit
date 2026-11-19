export type AssetPath = string;
export type ReferencePath = string;
export type CompressionMode = "auto" | "manual-quick" | "manual-dialog" | "document";
export type OperationKind = "saved-only" | "replaced" | "incomplete";

export interface OccurrenceTarget {
  rootID: string;
  notebook: string;
  blockID: string;
  oldPath: ReferencePath;
  /** Absolute image order in the block DOM. Always validate baselineBlockDOM before writing. */
  imageOrdinal: number;
  /** Persisted block snapshot captured before asynchronous work starts. */
  baselineBlockDOM: string;
}

export interface DockRecord {
  originalPath: AssetPath;
  compressedPath: AssetPath;
  updatedAt: number;
  lastOperation: OperationKind;
}

export type CompressionRecord = DockRecord;
