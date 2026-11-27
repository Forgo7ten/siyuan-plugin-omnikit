import {
  alignBlockGroups,
  longestIncreasingSubsequencePairs,
  type BlockAlignBudget,
} from "./blockAlign.ts";
import {
  buildBlockGroups,
  buildCompactBigramSketch,
  EMPTY_SKETCH,
  isLowEntropyCodeLine,
  normalizeWhitespace,
  sortedMultisetDice,
  type BlockGroup,
} from "./blockSimilarity.ts";
import {
  semanticKey,
  summarizeDiffCounts,
  type DiffHunk,
  type DiffResult,
  type DiffUnitPair,
  type MatchAnchor,
  type SemanticUnit,
  type Side,
} from "./types.ts";

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
const INTRA_ANCHOR_SPLIT_THRESHOLD = 64;

type IntraUnitStep =
  | { type: "equal"; leftUnitIndex: number; rightUnitIndex: number }
  | { type: "modified-pair"; leftUnit: SemanticUnit; rightUnit: SemanticUnit }
  | { type: "intra-left"; leftUnit: SemanticUnit }
  | { type: "intra-right"; rightUnit: SemanticUnit }
  | { type: "intra-unresolved"; leftUnits: SemanticUnit[]; rightUnits: SemanticUnit[] };

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

  const isUnitStrictlyEqual = (li: number, rj: number): boolean =>
    left[li]!.reliable && right[rj]!.reliable && keysL[li] === keysR[rj];

  const alignPairedBlockUnits = (gL: BlockGroup, gR: BlockGroup): IntraUnitStep[] => {
    const baseL = gL.startUnitIndex;
    const baseR = gR.startUnitIndex;
    if (gL.units.length === 1 && gR.units.length === 1) {
      if (isUnitStrictlyEqual(baseL, baseR)) {
        return [{ type: "equal", leftUnitIndex: baseL, rightUnitIndex: baseR }];
      }
      return [{ type: "modified-pair", leftUnit: gL.units[0]!, rightUnit: gR.units[0]! }];
    }

    const out: IntraUnitStep[] = [];
    const findUniqueIntraAnchors = (
      a: number,
      b: number,
      c: number,
      d: number,
    ): Array<[number, number]> => {
      const countsL = new Map<string, number>();
      const normCountsL = new Map<string, number>();
      const idxL = new Map<string, number>();
      const normByKey = new Map<string, string>();
      for (let i = a; i < b; i++) {
        const u = left[i]!;
        const norm = normalizeWhitespace(u.text);
        if (!u.reliable || norm === "" || (u.kind === "NodeCodeBlock" && isLowEntropyCodeLine(norm))) {
          continue;
        }
        normCountsL.set(norm, (normCountsL.get(norm) ?? 0) + 1);
        const k = keysL[i]!;
        countsL.set(k, (countsL.get(k) ?? 0) + 1);
        idxL.set(k, i);
        normByKey.set(k, norm);
      }
      if (countsL.size === 0) return [];

      const countsR = new Map<string, number>();
      const normCountsR = new Map<string, number>();
      const idxR = new Map<string, number>();
      for (let j = c; j < d; j++) {
        const u = right[j]!;
        const norm = normalizeWhitespace(u.text);
        if (!u.reliable || norm === "" || (u.kind === "NodeCodeBlock" && isLowEntropyCodeLine(norm))) {
          continue;
        }
        normCountsR.set(norm, (normCountsR.get(norm) ?? 0) + 1);
        const k = keysR[j]!;
        if (!countsL.has(k)) continue;
        countsR.set(k, (countsR.get(k) ?? 0) + 1);
        idxR.set(k, j);
      }
      const pairs: Array<[number, number]> = [];
      for (const [k, cL] of countsL) {
        if (cL !== 1 || countsR.get(k) !== 1) continue;
        const norm = normByKey.get(k)!;
        if (normCountsL.get(norm) === 1 && normCountsR.get(norm) === 1) {
          pairs.push([idxL.get(k)!, idxR.get(k)!]);
        }
      }
      return longestIncreasingSubsequencePairs(pairs);
    };

    const emitWeightedIntraDP = (a: number, b: number, c: number, d: number): boolean => {
      const n = b - a;
      const m = d - c;
      const width = m + 1;
      if (n + 1 > Math.floor(budget.maxCells / width) || n + 1 > Math.floor(budget.remaining / width)) {
        return false;
      }
      const cells = (n + 1) * width;
      budget.remaining -= cells;

      // Precompute normalized line strings and compact `Uint32Array` 2-char sketches once per line (`O(n + m)`),
      // avoiding `Map` or temporary object allocations inside the `O(n * m)` DP matrix loop.
      const normL = new Array<string>(n);
      const lowEntropyL = new Uint8Array(n);
      const sketchL = new Array<Uint32Array>(n);
      for (let i = 0; i < n; i++) {
        const u = left[a + i]!;
        const norm = normalizeWhitespace(u.text);
        const low = u.kind === "NodeCodeBlock" && isLowEntropyCodeLine(norm);
        normL[i] = norm;
        lowEntropyL[i] = low ? 1 : 0;
        sketchL[i] = norm.length >= 2 && norm.length <= 400 && !low ? buildCompactBigramSketch(norm) : EMPTY_SKETCH;
      }

      const normR = new Array<string>(m);
      const lowEntropyR = new Uint8Array(m);
      const sketchR = new Array<Uint32Array>(m);
      for (let j = 0; j < m; j++) {
        const u = right[c + j]!;
        const norm = normalizeWhitespace(u.text);
        const low = u.kind === "NodeCodeBlock" && isLowEntropyCodeLine(norm);
        normR[j] = norm;
        lowEntropyR[j] = low ? 1 : 0;
        sketchR[j] = norm.length >= 2 && norm.length <= 400 && !low ? buildCompactBigramSketch(norm) : EMPTY_SKETCH;
      }

      const weights = new Int16Array(n * m);
      const exactFlags = new Uint8Array(n * m);
      for (let i = 0; i < n; i++) {
        const uL = left[a + i]!;
        const keyL = keysL[a + i]!;
        const nL = normL[i]!;
        const lowL = lowEntropyL[i]! === 1;
        const skL = sketchL[i]!;
        for (let j = 0; j < m; j++) {
          const uR = right[c + j]!;
          const pIdx = i * m + j;
          if (!uL.reliable || !uR.reliable || uL.kind !== uR.kind) continue;

          if (keyL === keysR[c + j]) {
            exactFlags[pIdx] = 1;
            if (uL.text === "" && uL.kind !== "NodeTableRow") {
              weights[pIdx] = 15;
            } else if (lowL) {
              weights[pIdx] = 25;
            } else {
              weights[pIdx] = 100;
            }
            continue;
          }

          if (uL.text === "" && uR.text === "") {
            weights[pIdx] = 12;
            continue;
          }
          if (uL.text === "" || uR.text === "") continue;

          const nR = normR[j]!;
          if (nL.length > 0 && nL === nR) {
            weights[pIdx] = lowL ? 20 : 85;
            continue;
          }
          if (lowL || lowEntropyR[j]! === 1) continue;

          if (nL.length <= 400 && nR.length <= 400) {
            let sim = 0;
            if (nL.length === 1 || nR.length === 1) {
              sim = nL.includes(nR) || nR.includes(nL) ? 2 / (nL.length + nR.length) : 0;
            } else {
              sim = sortedMultisetDice(skL, sketchR[j]!);
            }
            if (sim >= 0.4) {
              weights[pIdx] = Math.round(30 + 45 * sim);
            }
          }
        }
      }

      const dp = new Int32Array(cells);
      for (let i = n - 1; i >= 0; i--) {
        for (let j = m - 1; j >= 0; j--) {
          const idx = i * width + j;
          const down = dp[(i + 1) * width + j]!;
          const across = dp[i * width + j + 1]!;
          let best = down >= across ? down : across;
          const w = weights[i * m + j]!;
          if (w > 0) {
            const diag = dp[(i + 1) * width + j + 1]! + w;
            if (diag >= best) best = diag;
          }
          dp[idx] = best;
        }
      }

      const rawSteps: IntraUnitStep[] = [];
      let i = 0;
      let j = 0;
      while (i < n || j < m) {
        if (i < n && j < m) {
          const pIdx = i * m + j;
          const w = weights[pIdx]!;
          if (w > 0 && dp[i * width + j]! === dp[(i + 1) * width + j + 1]! + w) {
            if (exactFlags[pIdx] === 1) {
              rawSteps.push({ type: "equal", leftUnitIndex: a + i, rightUnitIndex: c + j });
            } else {
              rawSteps.push({ type: "modified-pair", leftUnit: left[a + i]!, rightUnit: right[c + j]! });
            }
            i++;
            j++;
            continue;
          }
        }
        if (i < n && (j === m || dp[(i + 1) * width + j]! >= dp[i * width + j + 1]!)) {
          rawSteps.push({ type: "intra-left", leftUnit: left[a + i]! });
          i++;
        } else {
          rawSteps.push({ type: "intra-right", rightUnit: right[c + j]! });
          j++;
        }
      }

      // Within a paired block, if a local gap between matched/paired lines has equal numbers of
      // non-empty `intra-left` and `intra-right` lines (e.g. a rewritten line `foo()` -> `bar()`),
      // pair them 1:1 so character-level inline diff still highlights the changed tokens.
      for (let k = 0; k < rawSteps.length;) {
        const s = rawSteps[k]!;
        if (s.type !== "intra-left" && s.type !== "intra-right") {
          out.push(s);
          k++;
          continue;
        }
        const gapLeft: SemanticUnit[] = [];
        const gapRight: SemanticUnit[] = [];
        while (
          k < rawSteps.length &&
          (rawSteps[k]!.type === "intra-left" || rawSteps[k]!.type === "intra-right")
        ) {
          const cur = rawSteps[k++]!;
          if (cur.type === "intra-left") gapLeft.push(cur.leftUnit);
          else if (cur.type === "intra-right") gapRight.push(cur.rightUnit);
        }
        if (
          gapLeft.length > 0 &&
          gapLeft.length === gapRight.length &&
          gapLeft.every(u => u.text.length > 0 && u.reliable) &&
          gapRight.every(u => u.text.length > 0 && u.reliable)
        ) {
          for (let p = 0; p < gapLeft.length; p++) {
            out.push({ type: "modified-pair", leftUnit: gapLeft[p]!, rightUnit: gapRight[p]! });
          }
        } else {
          for (const u of gapLeft) out.push({ type: "intra-left", leftUnit: u });
          for (const u of gapRight) out.push({ type: "intra-right", rightUnit: u });
        }
      }
      return true;
    };

    const visitUnits = (a: number, b: number, c: number, d: number): void => {
      while (a < b && c < d && isUnitStrictlyEqual(a, c)) {
        out.push({ type: "equal", leftUnitIndex: a++, rightUnitIndex: c++ });
      }
      const suffix: Array<[number, number]> = [];
      while (a < b && c < d && isUnitStrictlyEqual(b - 1, d - 1)) {
        suffix.push([--b, --d]);
      }

      if (a === b) {
        for (let j = c; j < d; j++) out.push({ type: "intra-right", rightUnit: right[j]! });
      } else if (c === d) {
        for (let i = a; i < b; i++) out.push({ type: "intra-left", leftUnit: left[i]! });
      } else {
        let handled = false;
        let checkedAnchors = false;
        if ((b - a) * (d - c) > INTRA_ANCHOR_SPLIT_THRESHOLD) {
          checkedAnchors = true;
          const anchors = findUniqueIntraAnchors(a, b, c, d);
          if (anchors.length > 0) {
            let prevL = a;
            let prevR = c;
            for (const [li, rj] of anchors) {
              visitUnits(prevL, li, prevR, rj);
              out.push({ type: "equal", leftUnitIndex: li, rightUnitIndex: rj });
              prevL = li + 1;
              prevR = rj + 1;
            }
            visitUnits(prevL, b, prevR, d);
            handled = true;
          }
        }

        if (!handled && !emitWeightedIntraDP(a, b, c, d)) {
          const fallbackAnchors = checkedAnchors ? [] : findUniqueIntraAnchors(a, b, c, d);
          if (fallbackAnchors.length === 0) {
            out.push({
              type: "intra-unresolved",
              leftUnits: left.slice(a, b),
              rightUnits: right.slice(c, d),
            });
          } else {
            let prevL = a;
            let prevR = c;
            for (const [li, rj] of fallbackAnchors) {
              visitUnits(prevL, li, prevR, rj);
              out.push({ type: "equal", leftUnitIndex: li, rightUnitIndex: rj });
              prevL = li + 1;
              prevR = rj + 1;
            }
            visitUnits(prevL, b, prevR, d);
          }
        }
      }

      for (let idx = suffix.length - 1; idx >= 0; idx--) {
        const [li, rj] = suffix[idx]!;
        out.push({ type: "equal", leftUnitIndex: li, rightUnitIndex: rj });
      }
    };

    visitUnits(baseL, baseL + gL.units.length, baseR, baseR + gR.units.length);
    return out;
  };

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
    const intraSteps = alignPairedBlockUnits(gL, gR);
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
