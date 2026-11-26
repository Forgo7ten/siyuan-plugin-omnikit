export type Side = "left" | "right";

export interface TextSpan {
  start: number;
  end: number;
}

/**
 * Block-ID-neutral semantic comparison unit.
 * `blockID` is a local DOM locator only and is excluded from `semanticKey`.
 */
export interface SemanticUnit {
  blockID?: string;
  kind: string;
  context: string;
  text: string;
  format: string;
  target: string;
  line: number;
  tableRowIndex?: number;
  reliable: boolean;
  unresolvedReason?: string;
}

export type HunkKind = "left-only" | "right-only" | "modified" | "unresolved" | "title";

export type DiffFilter = "all" | "removed" | "added" | "modified" | "unresolved";

export type SessionStatusKind = "comparing" | "unconfirmed" | "equal" | "diff" | "unresolved" | "failed";

export interface DiffHunk {
  kind: HunkKind;
  left: SemanticUnit[];
  right: SemanticUnit[];
  /** Logical unit indices in document order, independent of block IDs. */
  leftIndex: number;
  rightIndex: number;
  key: string;
}

export interface MatchAnchor {
  leftIndex: number;
  rightIndex: number;
  leftBlockID?: string;
  rightBlockID?: string;
}

export interface DiffCounts {
  all: number;
  removed: number;
  added: number;
  modified: number;
  unresolved: number;
  confirmedDiff: number;
}

export interface DiffResult {
  hunks: DiffHunk[];
  matches: MatchAnchor[];
  unresolved: boolean;
  counts: DiffCounts;
}

export interface DocumentIdentityLabel {
  id: string;
  title: string;
  notebook: string;
  notebookName?: string;
  hPath?: string;
}

export const EMPTY_DIFF_COUNTS: DiffCounts = {
  all: 0,
  removed: 0,
  added: 0,
  modified: 0,
  unresolved: 0,
  confirmedDiff: 0,
};

export const EMPTY_DIFF_RESULT: DiffResult = {
  hunks: [],
  matches: [],
  unresolved: false,
  counts: { ...EMPTY_DIFF_COUNTS },
};

export function semanticKey(unit: SemanticUnit): string {
  return JSON.stringify([
    unit.kind,
    unit.context,
    unit.text.replace(/\r\n?/g, "\n"),
    unit.format,
    unit.target,
  ]);
}

export function matchesDiffFilter(hunk: DiffHunk, filter: DiffFilter): boolean {
  switch (filter) {
    case "all":
      return true;
    case "removed":
      return hunk.kind === "left-only";
    case "added":
      return hunk.kind === "right-only";
    case "modified":
      return hunk.kind === "modified" || hunk.kind === "title";
    case "unresolved":
      return hunk.kind === "unresolved";
  }
}

export function summarizeDiffCounts(hunks: readonly DiffHunk[]): DiffCounts {
  let removed = 0;
  let added = 0;
  let modified = 0;
  let unresolved = 0;
  for (const hunk of hunks) {
    if (hunk.kind === "left-only") removed++;
    else if (hunk.kind === "right-only") added++;
    else if (hunk.kind === "modified" || hunk.kind === "title") modified++;
    else if (hunk.kind === "unresolved") unresolved++;
  }
  return {
    all: hunks.length,
    removed,
    added,
    modified,
    unresolved,
    confirmedDiff: removed + added + modified,
  };
}
