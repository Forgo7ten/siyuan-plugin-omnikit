import { alignBlockGroups, type BlockAlignBudget } from "./blockAlign.ts";
import { findNearestMatchedBlockID } from "./blockMapping.ts";
import { buildBlockGroups } from "./blockSimilarity.ts";
import { alignPairedBlockUnits } from "./intraBlockAlign.ts";
import {
  semanticKey,
  summarizeDiffCounts,
  type DiffHunk,
  type DiffResult,
  type DiffUnitPair,
  type MatchAnchor,
  type SemanticUnit,
} from "./types.ts";

export { findNearestMatchedBlockID };

export interface AlignmentOptions {
  maxCells?: number;
  totalCells?: number;
  maxUnits?: number;
}

const DEFAULT_MAX_CELLS = 2_000_000;
const CEILING_MAX_CELLS = 2_000_000;
const DEFAULT_TOTAL_CELLS = 8_000_000;
const CEILING_TOTAL_CELLS = 8_000_000;
const DEFAULT_MAX_UNITS = 10_000;

function boundedPositiveInt(value: number | undefined, fallback: number, ceiling: number): number {
  return typeof value === "number" && Number.isInteger(value) && value > 0
    ? Math.min(value, ceiling)
    : fallback;
}

function fnv1aHash(text: string): string {
  let hash = 2166136261;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16);
}

/**
 * Block-aware logical unit alignment with monotonic BlockGroup pairing, weighted intra-block line
 * alignment (preventing delimiter/brace cross-level drift under indentation shifts), and bounded budgets.
 */
export function alignUnits(
  left: readonly SemanticUnit[],
  right: readonly SemanticUnit[],
  options: AlignmentOptions = {},
): DiffResult {
  const maxCells = boundedPositiveInt(options.maxCells, DEFAULT_MAX_CELLS, CEILING_MAX_CELLS);
  const totalCells = boundedPositiveInt(options.totalCells, DEFAULT_TOTAL_CELLS, CEILING_TOTAL_CELLS);
  const maxUnits = boundedPositiveInt(options.maxUnits, DEFAULT_MAX_UNITS, DEFAULT_MAX_UNITS);
  const budget: BlockAlignBudget = {
    remaining: totalCells,
    maxCells,
  };

  if (left.length > maxUnits || right.length > maxUnits) {
    const hunk: DiffHunk = {
      kind: "unresolved",
      left: [...left],
      right: [...right],
      leftIndex: 0,
      rightIndex: 0,
      key: "unresolved:max-units-exceeded",
    };
    const counts = summarizeDiffCounts([hunk]);
    return {
      hunks: [hunk],
      matches: [],
      unresolved: counts.unresolved > 0,
      counts,
    };
  }

  const keysL = left.map(semanticKey);
  const keysR = right.map(semanticKey);
  const blocksL = buildBlockGroups(left, keysL);
  const blocksR = buildBlockGroups(right, keysR);
  const blockSteps = alignBlockGroups(blocksL, blocksR, budget);

  // Assemble `matches` and `hunks` while keeping whole unpaired blocks strictly as `left-only` / `right-only`
  // and merging contiguous changes across paired `modified` blocks with explicit `pairedUnits`.
  const hunks: DiffHunk[] = [];
  const matches: MatchAnchor[] = [];
  let leftPos = 0;
  let rightPos = 0;

  type OpenBufferKind = "none" | "intra" | "left-only-blocks" | "right-only-blocks" | "unresolved";
  let openKind: OpenBufferKind = "none";
  let bufLeft: SemanticUnit[] = [];
  let bufRight: SemanticUnit[] = [];
  let bufPairs: DiffUnitPair[] = [];
  let bufStartL = 0;
  let bufStartR = 0;

  const flushOpenBuffer = (): void => {
    if (openKind === "none" || (bufLeft.length === 0 && bufRight.length === 0)) {
      openKind = "none";
      bufLeft = [];
      bufRight = [];
      bufPairs = [];
      return;
    }

    const hasUnreliable = bufLeft.some(u => !u.reliable) || bufRight.some(u => !u.reliable);
    const kind =
      openKind === "unresolved" || hasUnreliable
        ? "unresolved"
        : bufLeft.length > 0 && bufRight.length > 0
          ? "modified"
          : bufLeft.length > 0
            ? "left-only"
            : "right-only";
    const sample = bufLeft[0] ?? bufRight[0]!;
    const hunk: DiffHunk = {
      kind,
      left: bufLeft,
      right: bufRight,
      ...(kind === "modified" ? { pairedUnits: bufPairs } : {}),
      leftIndex: bufStartL,
      rightIndex: bufStartR,
      key: `${kind}:${bufStartL}:${bufStartR}:${fnv1aHash(semanticKey(sample))}`,
    };
    hunks.push(hunk);
    openKind = "none";
    bufLeft = [];
    bufRight = [];
    bufPairs = [];
  };

  const ensureBuffer = (desired: Exclude<OpenBufferKind, "none">): void => {
    if (openKind !== desired) {
      flushOpenBuffer();
      openKind = desired;
      bufStartL = leftPos;
      bufStartR = rightPos;
    }
  };

  for (const step of blockSteps) {
    if (step.type === "equal-block") {
      flushOpenBuffer();
      const gL = blocksL[step.leftBlock]!;
      const gR = blocksR[step.rightBlock]!;
      for (let k = 0; k < gL.units.length; k++) {
        const li = gL.startUnitIndex + k;
        const rj = gR.startUnitIndex + k;
        matches.push({
          leftIndex: li,
          rightIndex: rj,
          leftBlockID: left[li]!.blockID,
          rightBlockID: right[rj]!.blockID,
        });
        leftPos++;
        rightPos++;
      }
      continue;
    }

    if (step.type === "unresolved-blocks") {
      ensureBuffer("unresolved");
      for (let bi = step.leftStart; bi < step.leftEnd; bi++) {
        const uList = blocksL[bi]!.units;
        bufLeft.push(...uList);
        leftPos += uList.length;
      }
      for (let bj = step.rightStart; bj < step.rightEnd; bj++) {
        const uList = blocksR[bj]!.units;
        bufRight.push(...uList);
        rightPos += uList.length;
      }
      continue;
    }

    if (step.type === "left-block") {
      const gL = blocksL[step.leftBlock]!;
      ensureBuffer(gL.reliable ? "left-only-blocks" : "unresolved");
      bufLeft.push(...gL.units);
      leftPos += gL.units.length;
      continue;
    }

    if (step.type === "right-block") {
      const gR = blocksR[step.rightBlock]!;
      ensureBuffer(gR.reliable ? "right-only-blocks" : "unresolved");
      bufRight.push(...gR.units);
      rightPos += gR.units.length;
      continue;
    }

    // `step.type === "paired-block"`
    const gL = blocksL[step.leftBlock]!;
    const gR = blocksR[step.rightBlock]!;
    const intraSteps = alignPairedBlockUnits(left, right, keysL, keysR, gL, gR, budget);
    for (const intra of intraSteps) {
      if (intra.type === "equal") {
        flushOpenBuffer();
        matches.push({
          leftIndex: intra.leftUnitIndex,
          rightIndex: intra.rightUnitIndex,
          leftBlockID: left[intra.leftUnitIndex]!.blockID,
          rightBlockID: right[intra.rightUnitIndex]!.blockID,
        });
        leftPos++;
        rightPos++;
      } else if (intra.type === "intra-unresolved") {
        ensureBuffer("unresolved");
        bufLeft.push(...intra.leftUnits);
        bufRight.push(...intra.rightUnits);
        leftPos += intra.leftUnits.length;
        rightPos += intra.rightUnits.length;
      } else if (intra.type === "modified-pair") {
        ensureBuffer("intra");
        const lIdx = bufLeft.length;
        const rIdx = bufRight.length;
        bufLeft.push(intra.leftUnit);
        bufRight.push(intra.rightUnit);
        bufPairs.push({ leftIndex: lIdx, rightIndex: rIdx });
        leftPos++;
        rightPos++;
      } else if (intra.type === "intra-left") {
        ensureBuffer("intra");
        bufLeft.push(intra.leftUnit);
        leftPos++;
      } else if (intra.type === "intra-right") {
        ensureBuffer("intra");
        bufRight.push(intra.rightUnit);
        rightPos++;
      }
    }
  }

  flushOpenBuffer();

  const counts = summarizeDiffCounts(hunks);
  return {
    hunks,
    matches,
    unresolved: counts.unresolved > 0,
    counts,
  };
}

/**
 * Keeps navigation at the same hunk when still present, or advances to the nearest logical hunk.
 */
export function retainHunkCursor(
  previous: DiffHunk | undefined,
  nextHunks: readonly DiffHunk[],
): number {
  if (!previous || nextHunks.length === 0) return 0;
  const exact = nextHunks.findIndex(h => h.key === previous.key);
  if (exact >= 0) return exact;

  // Prefer the first hunk at or after the previous logical position before falling back to closest overall.
  const forward = nextHunks.findIndex(
    h => h.leftIndex >= previous.leftIndex && h.rightIndex >= previous.rightIndex,
  );
  if (forward >= 0) return forward;

  let bestIndex = 0;
  let bestDistance = Number.POSITIVE_INFINITY;
  for (let i = 0; i < nextHunks.length; i++) {
    const hunk = nextHunks[i]!;
    const dist = Math.abs(hunk.leftIndex - previous.leftIndex) + Math.abs(hunk.rightIndex - previous.rightIndex);
    if (dist < bestDistance) {
      bestDistance = dist;
      bestIndex = i;
    }
  }
  return bestIndex;
}
