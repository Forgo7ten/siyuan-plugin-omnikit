export type AssetPath = string;
export type ReferencePath = string;
export type CompressionMode = "auto" | "manual-quick" | "manual-dialog" | "document";
export type OperationKind = "saved-only" | "replaced" | "incomplete";
export type AssetAvailability = "present" | "missing-confirmed" | "unknown";

export interface OccurrenceTarget {
  readonly rootID: string;
  readonly notebook: string;
  readonly blockID: string;
  readonly kind?: "image" | "link";
  readonly attribute?: "data-src" | "src" | "data-href" | "href";
  /** 0-based order among matching candidate elements in the block DOM. */
  readonly imageOrdinal: number;
  readonly oldPath: ReferencePath;
  /** Persisted block snapshot captured before asynchronous work starts. */
  readonly baselineBlockDOM: string;
}

export interface DockRecord {
  originalPath: AssetPath;
  compressedPath: AssetPath;
  updatedAt: number;
  lastOperation: OperationKind;
}

export type CompressionRecord = DockRecord;
