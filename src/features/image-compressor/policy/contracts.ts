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
  /** 目标在所属块内同类元素中的序号（从 0 开始）。 */
  readonly imageOrdinal: number;
  readonly oldPath: ReferencePath;
}

export interface DockRecord {
  originalPath: AssetPath;
  compressedPath: AssetPath;
  updatedAt: number;
  lastOperation: OperationKind;
}

export type CompressionRecord = DockRecord;
