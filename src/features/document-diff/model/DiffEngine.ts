import {
  semanticKey,
  summarizeDiffCounts,
  type DiffHunk,
  type DiffResult,
  type MatchAnchor,
  type SemanticUnit,
  type Side,
} from "./types.ts";

type Step =
  | { type: "="; left: number; right: number }
  | { type: "-"; left: number }
  | { type: "+"; right: number }
  | { type: "?"; leftStart: number; leftEnd: number; rightStart: number; rightEnd: number };

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
 * Content-first logical unit alignment with prefix/suffix stripping, unique-anchor LIS
 * decomposition, and bounded LCS dynamic programming (modeled on SiYuan's `history_diff.go` budgets).
 */
export function alignUnits(
  left: readonly SemanticUnit[],
  right: readonly SemanticUnit[],
  options: AlignmentOptions = {},
): DiffResult {
  const maxCells = boundedPositiveInt(options.maxCells, DEFAULT_MAX_CELLS, CEILING_MAX_CELLS);
  let remainingCells = boundedPositiveInt(options.totalCells, DEFAULT_TOTAL_CELLS, CEILING_TOTAL_CELLS);
  const maxUnits = boundedPositiveInt(options.maxUnits, DEFAULT_MAX_UNITS, DEFAULT_MAX_UNITS);

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
      unresolved: true,
      counts,
    };
  }

  const keysL = left.map(semanticKey);
  const keysR = right.map(semanticKey);
  const steps: Step[] = [];

  const isEqual = (i: number, j: number): boolean =>
    left[i]!.reliable && right[j]!.reliable && keysL[i] === keysR[j];

  const emitBoundedLCS = (a: number, b: number, c: number, d: number): boolean => {
    const n = b - a;
    const m = d - c;
    const width = m + 1;
    if (n + 1 > Math.floor(maxCells / width) || n + 1 > Math.floor(remainingCells / width)) {
      return false;
    }
    const cells = (n + 1) * width;
    remainingCells -= cells;
    const dp = new Uint32Array(cells);
    for (let i = n - 1; i >= 0; i--) {
      for (let j = m - 1; j >= 0; j--) {
        const idx = i * width + j;
        if (isEqual(a + i, c + j)) {
          dp[idx] = dp[(i + 1) * width + j + 1]! + 1;
        } else {
          const down = dp[(i + 1) * width + j]!;
          const across = dp[i * width + j + 1]!;
          dp[idx] = down >= across ? down : across;
        }
      }
    }
    let i = 0;
    let j = 0;
    while (i < n || j < m) {
      if (i < n && j < m && isEqual(a + i, c + j)) {
        steps.push({ type: "=", left: a + i, right: c + j });
        i++;
        j++;
      } else if (i < n && (j === m || dp[(i + 1) * width + j]! >= dp[i * width + j + 1]!)) {
        steps.push({ type: "-", left: a + i });
        i++;
      } else {
        steps.push({ type: "+", right: c + j });
        j++;
      }
    }
    return true;
  };

  const findUniqueMonotoneAnchors = (
    a: number,
    b: number,
    c: number,
    d: number,
  ): Array<[number, number]> => {
    const leftCounts = new Map<string, number>();
    const leftIdx = new Map<string, number>();
    for (let i = a; i < b; i++) {
      if (!left[i]!.reliable) continue;
      const key = keysL[i]!;
      leftCounts.set(key, (leftCounts.get(key) ?? 0) + 1);
      leftIdx.set(key, i);
    }
    const rightCounts = new Map<string, number>();
    const rightIdx = new Map<string, number>();
    for (let j = c; j < d; j++) {
      if (!right[j]!.reliable) continue;
      const key = keysR[j]!;
      rightCounts.set(key, (rightCounts.get(key) ?? 0) + 1);
      rightIdx.set(key, j);
    }

    const pairs: Array<[number, number]> = [];
    for (const [key, countL] of leftCounts) {
      if (countL === 1 && rightCounts.get(key) === 1) {
        pairs.push([leftIdx.get(key)!, rightIdx.get(key)!]);
      }
    }
    if (pairs.length === 0) return [];
    pairs.sort((x, y) => x[0] - y[0]);

    // Longest Increasing Subsequence over right indices guarantees monotonic alignment.
    const tails: number[] = [];
    const positions: number[] = [];
    const previous = new Int32Array(pairs.length).fill(-1);
    for (let k = 0; k < pairs.length; k++) {
      const rightPos = pairs[k]![1];
      let lo = 0;
      let hi = tails.length;
      while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if (tails[mid]! < rightPos) lo = mid + 1;
        else hi = mid;
      }
      if (lo > 0) previous[k] = positions[lo - 1]!;
      tails[lo] = rightPos;
      positions[lo] = k;
    }

    const out: Array<[number, number]> = [];
    let cursor = positions.length > 0 ? positions[positions.length - 1]! : -1;
    while (cursor >= 0) {
      out.push(pairs[cursor]!);
      cursor = previous[cursor]!;
    }
    out.reverse();
    return out;
  };

  const visit = (a: number, b: number, c: number, d: number): void => {
    while (a < b && c < d && isEqual(a, c)) {
      steps.push({ type: "=", left: a++, right: c++ });
    }
    const suffix: Array<[number, number]> = [];
    while (a < b && c < d && isEqual(b - 1, d - 1)) {
      suffix.push([--b, --d]);
    }
    if (a === b) {
      for (let j = c; j < d; j++) steps.push({ type: "+", right: j });
    } else if (c === d) {
      for (let i = a; i < b; i++) steps.push({ type: "-", left: i });
    } else if (!emitBoundedLCS(a, b, c, d)) {
      const anchors = findUniqueMonotoneAnchors(a, b, c, d);
      if (anchors.length === 0) {
        steps.push({ type: "?", leftStart: a, leftEnd: b, rightStart: c, rightEnd: d });
      } else {
        let prevL = a;
        let prevR = c;
        for (const [li, rj] of anchors) {
          visit(prevL, li, prevR, rj);
          steps.push({ type: "=", left: li, right: rj });
          prevL = li + 1;
          prevR = rj + 1;
        }
        visit(prevL, b, prevR, d);
      }
    }
    for (let idx = suffix.length - 1; idx >= 0; idx--) {
      const [li, rj] = suffix[idx]!;
      steps.push({ type: "=", left: li, right: rj });
    }
  };

  visit(0, left.length, 0, right.length);

  const hunks: DiffHunk[] = [];
  const matches: MatchAnchor[] = [];
  let leftPos = 0;
  let rightPos = 0;

  const pushHunk = (
    oldUnits: SemanticUnit[],
    newUnits: SemanticUnit[],
    li: number,
    ri: number,
    isUnresolved: boolean,
  ): void => {
    if (oldUnits.length === 0 && newUnits.length === 0) return;
    const kind = isUnresolved
      ? "unresolved"
      : oldUnits.length > 0 && newUnits.length > 0
        ? "modified"
        : oldUnits.length > 0
          ? "left-only"
          : "right-only";
    const sample = oldUnits[0] ?? newUnits[0]!;
    hunks.push({
      kind,
      left: oldUnits,
      right: newUnits,
      leftIndex: li,
      rightIndex: ri,
      key: `${kind}:${li}:${ri}:${fnv1aHash(semanticKey(sample))}`,
    });
  };

  for (let i = 0; i < steps.length;) {
    const step = steps[i]!;
    if (step.type === "=") {
      matches.push({
        leftIndex: step.left,
        rightIndex: step.right,
        leftBlockID: left[step.left]!.blockID,
        rightBlockID: right[step.right]!.blockID,
      });
      leftPos++;
      rightPos++;
      i++;
      continue;
    }
    if (step.type === "?") {
      const leftSlice = left.slice(step.leftStart, step.leftEnd);
      const rightSlice = right.slice(step.rightStart, step.rightEnd);
      pushHunk([...leftSlice], [...rightSlice], leftPos, rightPos, true);
      leftPos += leftSlice.length;
      rightPos += rightSlice.length;
      i++;
      continue;
    }
    const startL = leftPos;
    const startR = rightPos;
    const oldUnits: SemanticUnit[] = [];
    const newUnits: SemanticUnit[] = [];
    while (i < steps.length && (steps[i]!.type === "-" || steps[i]!.type === "+")) {
      const current = steps[i++]!;
      if (current.type === "-") {
        oldUnits.push(left[current.left]!);
        leftPos++;
      } else if (current.type === "+") {
        newUnits.push(right[current.right]!);
        rightPos++;
      }
    }
    const hasUnreliable = oldUnits.some(u => !u.reliable) || newUnits.some(u => !u.reliable);
    pushHunk(oldUnits, newUnits, startL, startR, hasUnreliable);
  }

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

/**
 * Finds the nearest matched block ID on `side` around a hunk when that side has no units of its own
 * (e.g., jumping to context on the left side when navigating to a `right-only` insertion).
 */
export function findNearestMatchedBlockID(
  matches: readonly MatchAnchor[],
  hunk: DiffHunk,
  side: Side,
): string | undefined {
  if (matches.length === 0) return undefined;
  const targetIndex = side === "left" ? hunk.leftIndex : hunk.rightIndex;
  let bestBefore: MatchAnchor | undefined;
  let bestAfter: MatchAnchor | undefined;

  for (const match of matches) {
    const blockID = side === "left" ? match.leftBlockID : match.rightBlockID;
    if (!blockID) continue;
    const pos = side === "left" ? match.leftIndex : match.rightIndex;
    if (pos <= targetIndex) {
      if (!bestBefore || pos > (side === "left" ? bestBefore.leftIndex : bestBefore.rightIndex)) {
        bestBefore = match;
      }
    } else if (!bestAfter || pos < (side === "left" ? bestAfter.leftIndex : bestAfter.rightIndex)) {
      bestAfter = match;
    }
  }
  const chosen = bestBefore ?? bestAfter;
  return chosen ? (side === "left" ? chosen.leftBlockID : chosen.rightBlockID) : undefined;
}
