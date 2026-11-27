import { summarizeDiffCounts, type DiffHunk, type DiffResult, type SemanticUnit } from "./types.ts";

const CONFLICT_SUFFIX_RE = / \(Conflicted (\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2})\)$/;

export interface ConflictTitleInfo {
  baseTitle: string;
  timestamp: string;
  suffix: string;
}

export function parseConflictTitle(title: string): ConflictTitleInfo | null {
  if (typeof title !== "string" || !title) return null;
  const match = CONFLICT_SUFFIX_RE.exec(title);
  if (!match || match.index === 0) return null;
  const [, yearStr, monthStr, dayStr, hourStr, minuteStr, secondStr] = match;
  const year = Number(yearStr);
  const month = Number(monthStr);
  const day = Number(dayStr);
  const hour = Number(hourStr);
  const minute = Number(minuteStr);
  const second = Number(secondStr);

  // Use setUTCFullYear to avoid Date.UTC's 1900-offset coercion for years 00..99.
  const probe = new Date(0);
  probe.setUTCFullYear(year, month - 1, day);
  probe.setUTCHours(hour, minute, second, 0);
  if (
    probe.getUTCFullYear() !== year ||
    probe.getUTCMonth() !== month - 1 ||
    probe.getUTCDate() !== day ||
    probe.getUTCHours() !== hour ||
    probe.getUTCMinutes() !== minute ||
    probe.getUTCSeconds() !== second
  ) {
    return null;
  }

  return {
    baseTitle: title.slice(0, match.index),
    timestamp: `${yearStr}-${monthStr}-${dayStr} ${hourStr}:${minuteStr}:${secondStr}`,
    suffix: match[0],
  };
}

export function parentDocPath(docPath: string): string {
  if (typeof docPath !== "string" || !/^\/[^\\]*\.sy$/.test(docPath) || docPath.includes("..")) {
    throw new Error("Invalid SiYuan document path");
  }
  const slashIndex = docPath.lastIndexOf("/");
  return slashIndex === 0 ? "/" : docPath.slice(0, slashIndex);
}

export interface DocumentLocation {
  notebook: string;
  path: string;
}

export interface SiblingEntry {
  id: string;
  path: string;
  name: string;
  specTooNew?: boolean;
  titleFormat?: string;
}

export interface ConflictReadGateway {
  location(id: string): Promise<DocumentLocation>;
  title(id: string, notebook: string): Promise<string>;
  siblings(notebook: string, parentPath: string, maxCount: number): Promise<SiblingEntry[]>;
}

export type ConflictManualReasonCode =
  | "conflict-unreadable"
  | "nested-conflict"
  | "truncated"
  | "unverifiable-sibling"
  | "moved-during-lookup"
  | "multiple-candidates"
  | "no-candidate"
  | "lookup-failed";

export type ConflictMatchOutcome =
  | { kind: "not-conflict" }
  | { kind: "matched"; originalID: string; conflictID: string; baseTitle: string }
  | {
      kind: "manual-required";
      reasonCode: ConflictManualReasonCode;
      conflictID: string;
      baseTitle?: string;
    };

function matchesBaseTitleCandidate(rawName: string, baseTitle: string): boolean {
  if (rawName === baseTitle) return true;
  if (rawName.endsWith(".sy") && rawName.slice(0, -3) === baseTitle) return true;
  return false;
}

/**
 * Resolves the unique original document strictly within the same notebook and direct parent folder.
 * Never performs fuzzy matching, case folding, recursive parent search, or cross-folder lookup.
 */
export async function resolveOriginalDocument(
  conflictID: string,
  io: ConflictReadGateway,
  maxSiblings = 10_000,
): Promise<ConflictMatchOutcome> {
  let initialLocation: DocumentLocation;
  let initialTitle: string;
  try {
    initialLocation = await io.location(conflictID);
    initialTitle = await io.title(conflictID, initialLocation.notebook);
  } catch {
    return {
      kind: "manual-required",
      reasonCode: "conflict-unreadable",
      conflictID,
    };
  }

  const parsed = parseConflictTitle(initialTitle);
  if (!parsed) {
    return { kind: "not-conflict" };
  }
  if (parseConflictTitle(parsed.baseTitle)) {
    return {
      kind: "manual-required",
      reasonCode: "nested-conflict",
      conflictID,
      baseTitle: parsed.baseTitle,
    };
  }

  try {
    const parent = parentDocPath(initialLocation.path);
    const rows = await io.siblings(initialLocation.notebook, parent, maxSiblings);
    if (rows.length >= maxSiblings) {
      return {
        kind: "manual-required",
        reasonCode: "truncated",
        conflictID,
        baseTitle: parsed.baseTitle,
      };
    }
    if (rows.some(row => row.id !== conflictID && row.specTooNew)) {
      return {
        kind: "manual-required",
        reasonCode: "unverifiable-sibling",
        conflictID,
        baseTitle: parsed.baseTitle,
      };
    }

    const candidates = rows.filter(
      row =>
        Boolean(row.id) &&
        row.id !== conflictID &&
        parentDocPath(row.path) === parent &&
        (matchesBaseTitleCandidate(row.name, parsed.baseTitle) || row.titleFormat === "inline-ast"),
    );

    const verifiedIDs: string[] = [];
    for (const candidate of candidates) {
      const [actualTitle, candidateLocation] = await Promise.all([
        io.title(candidate.id, initialLocation.notebook),
        io.location(candidate.id),
      ]);
      if (
        actualTitle === parsed.baseTitle &&
        candidateLocation.notebook === initialLocation.notebook &&
        parentDocPath(candidateLocation.path) === parent
      ) {
        verifiedIDs.push(candidate.id);
      }
    }

    // TOCTOU verification: ensure the conflict document itself was not renamed or moved mid-flight.
    const [latestLocation, latestTitle] = await Promise.all([
      io.location(conflictID),
      io.title(conflictID, initialLocation.notebook),
    ]);
    if (
      latestLocation.notebook !== initialLocation.notebook ||
      parentDocPath(latestLocation.path) !== parent ||
      latestTitle !== initialTitle
    ) {
      return {
        kind: "manual-required",
        reasonCode: "moved-during-lookup",
        conflictID,
        baseTitle: parsed.baseTitle,
      };
    }

    if (verifiedIDs.length === 0) {
      return {
        kind: "manual-required",
        reasonCode: "no-candidate",
        conflictID,
        baseTitle: parsed.baseTitle,
      };
    }
    if (verifiedIDs.length > 1) {
      return {
        kind: "manual-required",
        reasonCode: "multiple-candidates",
        conflictID,
        baseTitle: parsed.baseTitle,
      };
    }

    return {
      kind: "matched",
      originalID: verifiedIDs[0]!,
      conflictID,
      baseTitle: parsed.baseTitle,
    };
  } catch {
    return {
      kind: "manual-required",
      reasonCode: "lookup-failed",
      conflictID,
      baseTitle: parsed.baseTitle,
    };
  }
}

/**
 * Strips the last valid conflict suffix only for the confirmed conflict document ID,
 * independent of whether panes were swapped visually.
 */
export function comparableTitle(
  docID: string,
  rawTitle: string,
  confirmedConflictID?: string,
): string {
  if (!confirmedConflictID || docID !== confirmedConflictID) {
    return rawTitle;
  }
  return parseConflictTitle(rawTitle)?.baseTitle ?? rawTitle;
}

export function applyComparableTitleHunk(
  diff: DiffResult,
  leftDoc: { id: string; title: string },
  rightDoc: { id: string; title: string },
  confirmedConflictID?: string,
): void {
  const cmpLeftTitle = comparableTitle(leftDoc.id, leftDoc.title, confirmedConflictID);
  const cmpRightTitle = comparableTitle(rightDoc.id, rightDoc.title, confirmedConflictID);
  if (cmpLeftTitle === cmpRightTitle) return;
  const makeTitleUnit = (title: string): SemanticUnit => ({
    kind: "Title",
    context: "",
    text: title,
    format: "",
    target: "",
    line: 0,
    reliable: true,
  });
  const titleHunk: DiffHunk = {
    kind: "title",
    left: [makeTitleUnit(cmpLeftTitle)],
    right: [makeTitleUnit(cmpRightTitle)],
    leftIndex: 0,
    rightIndex: 0,
    key: "title",
  };
  diff.hunks = [titleHunk, ...diff.hunks];
  diff.counts = summarizeDiffCounts(diff.hunks);
}
