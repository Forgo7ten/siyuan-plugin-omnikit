import {
  areBlockContainersCompatible,
  exactBlockMatchWeight,
  isBlockStrictlyEqual,
  isMeaningfulBlockAnchor,
  scoreModifiedBlockPair,
  type BlockGroup,
} from "./blockSimilarity.ts";
import { emitSparseBlockFenwickDP } from "./sparseBlockAlign.ts";

export { emitSparseBlockFenwickDP } from "./sparseBlockAlign.ts";

export type BlockAlignStep =
  | { type: "equal-block"; leftBlock: number; rightBlock: number }
  | { type: "paired-block"; leftBlock: number; rightBlock: number }
  | { type: "left-block"; leftBlock: number }
  | { type: "right-block"; rightBlock: number }
  | { type: "unresolved-blocks"; leftStart: number; leftEnd: number; rightStart: number; rightEnd: number };

export interface BlockAlignBudget {
  remaining: number;
  readonly maxCells: number;
}

const DENSE_BLOCK_CELL_THRESHOLD = 1024;

export function longestIncreasingSubsequencePairs(
  pairs: ReadonlyArray<[number, number]>,
): Array<[number, number]> {
  if (pairs.length === 0) return [];
  const sorted = [...pairs].sort((x, y) => x[0] - y[0]);
  const tails: number[] = [];
  const positions: number[] = [];
  const previous = new Int32Array(sorted.length).fill(-1);

  for (let k = 0; k < sorted.length; k++) {
    const rightPos = sorted[k]![1];
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
    out.push(sorted[cursor]!);
    cursor = previous[cursor]!;
  }
  out.reverse();
  return out;
}

export function findUniqueMonotoneBlockAnchors(
  blocksL: readonly BlockGroup[],
  blocksR: readonly BlockGroup[],
  a: number,
  b: number,
  c: number,
  d: number,
  nonTrivialOnly = true,
): Array<[number, number]> {
  const leftCounts = new Map<string, number>();
  const leftIdx = new Map<string, number>();
  for (let i = a; i < b; i++) {
    const g = blocksL[i]!;
    if (nonTrivialOnly ? !isMeaningfulBlockAnchor(g) : !g.reliable) continue;
    const sig = g.exactSignature;
    leftCounts.set(sig, (leftCounts.get(sig) ?? 0) + 1);
    leftIdx.set(sig, i);
  }
  if (leftCounts.size === 0) return [];

  const rightCounts = new Map<string, number>();
  const rightIdx = new Map<string, number>();
  for (let j = c; j < d; j++) {
    const g = blocksR[j]!;
    if (nonTrivialOnly ? !isMeaningfulBlockAnchor(g) : !g.reliable) continue;
    const sig = g.exactSignature;
    if (!leftCounts.has(sig)) continue;
    rightCounts.set(sig, (rightCounts.get(sig) ?? 0) + 1);
    rightIdx.set(sig, j);
  }

  const pairs: Array<[number, number]> = [];
  for (const [sig, countL] of leftCounts) {
    if (countL === 1 && rightCounts.get(sig) === 1) {
      pairs.push([leftIdx.get(sig)!, rightIdx.get(sig)!]);
    }
  }
  return longestIncreasingSubsequencePairs(pairs);
}

export function estimatePairMergeOps(gL: BlockGroup, gR: BlockGroup): number {
  if (!areBlockContainersCompatible(gL, gR)) return 1;
  return (
    gL.sketch.length +
    gR.sketch.length +
    gL.sortedMeaningfulLines.length +
    gR.sortedMeaningfulLines.length
  );
}

export function isBetterChainHead(
  scoreA: number,
  iA: number,
  jA: number,
  scoreB: number,
  iB: number,
  jB: number,
): boolean {
  if (scoreA !== scoreB) return scoreA > scoreB;
  if (iA !== iB) return iA < iB;
  return jA < jB;
}

export function emitChainSteps(
  blocksL: readonly BlockGroup[],
  blocksR: readonly BlockGroup[],
  edgeIList: readonly number[],
  edgeJList: readonly number[],
  edgeExactList: readonly number[],
  edgeNextList: readonly number[],
  headEdge: number,
  a: number,
  c: number,
  n: number,
  m: number,
  outSteps: BlockAlignStep[],
): boolean {
  let curEdge = headEdge;
  let curI = 0;
  let curJ = 0;

  const emitGap = (endI: number, endJ: number): void => {
    if (endI - curI === 1 && endJ - curJ === 1) {
      const gL = blocksL[a + curI]!;
      const gR = blocksR[c + curJ]!;
      if (isBlockStrictlyEqual(gL, gR)) {
        outSteps.push({ type: "equal-block", leftBlock: a + curI, rightBlock: c + curJ });
        curI = endI;
        curJ = endJ;
        return;
      }
      if (scoreModifiedBlockPair(gL, gR, true) > 0) {
        outSteps.push({ type: "paired-block", leftBlock: a + curI, rightBlock: c + curJ });
        curI = endI;
        curJ = endJ;
        return;
      }
    }
    while (curI < endI) {
      outSteps.push({ type: "left-block", leftBlock: a + curI++ });
    }
    while (curJ < endJ) {
      outSteps.push({ type: "right-block", rightBlock: c + curJ++ });
    }
  };

  while (curEdge >= 0) {
    const matchI = edgeIList[curEdge]!;
    const matchJ = edgeJList[curEdge]!;
    if (matchI < curI || matchJ < curJ) {
      return false;
    }
    emitGap(matchI, matchJ);
    if (edgeExactList[curEdge] === 1) {
      outSteps.push({ type: "equal-block", leftBlock: a + matchI, rightBlock: c + matchJ });
    } else {
      outSteps.push({ type: "paired-block", leftBlock: a + matchI, rightBlock: c + matchJ });
    }
    curI = matchI + 1;
    curJ = matchJ + 1;
    curEdge = edgeNextList[curEdge]!;
  }

  emitGap(n, m);
  return true;
}

/**
 * Exact dense block-group dynamic programming for small intervals (`n * m <= 1024`).
 */
export function emitDenseBlockDP(
  blocksL: readonly BlockGroup[],
  blocksR: readonly BlockGroup[],
  a: number,
  b: number,
  c: number,
  d: number,
  budget: BlockAlignBudget,
  outSteps: BlockAlignStep[],
): boolean {
  const n = b - a;
  const m = d - c;
  if (n === 0 && m === 0) return true;
  const width = m + 1;
  if (n + 1 > Math.floor(budget.maxCells / width) || n + 1 > Math.floor(budget.remaining / width)) {
    return false;
  }

  let segmentCells = (n + 1) * width;
  budget.remaining -= segmentCells;
  let opRemainder = 0;

  const consumeMergeOps = (ops: number): boolean => {
    opRemainder += ops;
    if (opRemainder < 4) return true;
    const extra = opRemainder >> 2;
    opRemainder &= 3;
    if (segmentCells + extra > budget.maxCells || extra > budget.remaining) {
      budget.remaining = Math.max(0, budget.remaining - extra);
      return false;
    }
    segmentCells += extra;
    budget.remaining -= extra;
    return true;
  };

  const isOneToOneGap = n === 1 && m === 1;
  const pairWeights = new Int32Array(n * m);
  const pairIsExact = new Uint8Array(n * m);

  for (let i = 0; i < n; i++) {
    const gL = blocksL[a + i]!;
    for (let j = 0; j < m; j++) {
      const gR = blocksR[c + j]!;
      const pIdx = i * m + j;
      if (isBlockStrictlyEqual(gL, gR)) {
        pairWeights[pIdx] = exactBlockMatchWeight(gL);
        pairIsExact[pIdx] = 1;
      } else {
        if (!isOneToOneGap && !consumeMergeOps(estimatePairMergeOps(gL, gR))) {
          return false;
        }
        pairWeights[pIdx] = scoreModifiedBlockPair(gL, gR, isOneToOneGap);
      }
    }
  }

  const totalCells = (n + 1) * width;
  const dpScore = new Float64Array(totalCells);
  const dpHeadI = new Int32Array(totalCells).fill(n + 1);
  const dpHeadJ = new Int32Array(totalCells).fill(m + 1);
  const dpHeadEdge = new Int32Array(totalCells).fill(-1);

  const edgeIList: number[] = [];
  const edgeJList: number[] = [];
  const edgeExactList: number[] = [];
  const edgeNextList: number[] = [];

  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      const idx = i * width + j;
      const downIdx = (i + 1) * width + j;
      const acrossIdx = i * width + j + 1;

      let bestScore = dpScore[downIdx]!;
      let bestI = dpHeadI[downIdx]!;
      let bestJ = dpHeadJ[downIdx]!;
      let bestEdge = dpHeadEdge[downIdx]!;

      if (
        dpHeadEdge[acrossIdx]! >= 0 &&
        (bestEdge < 0 ||
          isBetterChainHead(
            dpScore[acrossIdx]!,
            dpHeadI[acrossIdx]!,
            dpHeadJ[acrossIdx]!,
            bestScore,
            bestI,
            bestJ,
          ))
      ) {
        bestScore = dpScore[acrossIdx]!;
        bestI = dpHeadI[acrossIdx]!;
        bestJ = dpHeadJ[acrossIdx]!;
        bestEdge = dpHeadEdge[acrossIdx]!;
      }

      const pIdx = i * m + j;
      const w = pairWeights[pIdx]!;
      if (w > 0) {
        const diagIdx = (i + 1) * width + j + 1;
        const diagScore = w + dpScore[diagIdx]!;
        if (bestEdge < 0 || isBetterChainHead(diagScore, i, j, bestScore, bestI, bestJ)) {
          const edgeId = edgeIList.length;
          edgeIList.push(i);
          edgeJList.push(j);
          edgeExactList.push(pairIsExact[pIdx]!);
          edgeNextList.push(dpHeadEdge[diagIdx]!);
          bestScore = diagScore;
          bestI = i;
          bestJ = j;
          bestEdge = edgeId;
        }
      }

      dpScore[idx] = bestScore;
      dpHeadI[idx] = bestI;
      dpHeadJ[idx] = bestJ;
      dpHeadEdge[idx] = bestEdge;
    }
  }

  return emitChainSteps(
    blocksL,
    blocksR,
    edgeIList,
    edgeJList,
    edgeExactList,
    edgeNextList,
    dpHeadEdge[0]!,
    a,
    c,
    n,
    m,
    outSteps,
  );
}

/**
 * Aligns `blocksL` and `blocksR` via upfront non-trivial unique anchor splitting,
 * adaptive dense/sparse monotone pairing, and fallback full-anchor decomposition.
 */
export function alignBlockGroups(
  blocksL: readonly BlockGroup[],
  blocksR: readonly BlockGroup[],
  budget: BlockAlignBudget,
): BlockAlignStep[] {
  const blockSteps: BlockAlignStep[] = [];

  const visitBlocks = (a: number, b: number, c: number, d: number): void => {
    while (a < b && c < d && isBlockStrictlyEqual(blocksL[a]!, blocksR[c]!)) {
      blockSteps.push({ type: "equal-block", leftBlock: a++, rightBlock: c++ });
    }
    const suffix: Array<[number, number]> = [];
    while (a < b && c < d && isBlockStrictlyEqual(blocksL[b - 1]!, blocksR[d - 1]!)) {
      suffix.push([--b, --d]);
    }

    if (a === b) {
      for (let j = c; j < d; j++) blockSteps.push({ type: "right-block", rightBlock: j });
    } else if (c === d) {
      for (let i = a; i < b; i++) blockSteps.push({ type: "left-block", leftBlock: i });
    } else {
      let handled = false;
      if ((b - a) + (d - c) > 2) {
        const anchors = findUniqueMonotoneBlockAnchors(blocksL, blocksR, a, b, c, d, true);
        if (anchors.length > 0) {
          let prevL = a;
          let prevR = c;
          for (const [li, rj] of anchors) {
            visitBlocks(prevL, li, prevR, rj);
            blockSteps.push({ type: "equal-block", leftBlock: li, rightBlock: rj });
            prevL = li + 1;
            prevR = rj + 1;
          }
          visitBlocks(prevL, b, prevR, d);
          handled = true;
        }
      }

      if (!handled) {
        const n = b - a;
        const m = d - c;
        const solved =
          n * m <= DENSE_BLOCK_CELL_THRESHOLD
            ? emitDenseBlockDP(blocksL, blocksR, a, b, c, d, budget, blockSteps)
            : emitSparseBlockFenwickDP(blocksL, blocksR, a, b, c, d, budget, blockSteps);

        if (!solved) {
          const fallbackAnchors = findUniqueMonotoneBlockAnchors(blocksL, blocksR, a, b, c, d, false);
          if (fallbackAnchors.length === 0) {
            blockSteps.push({
              type: "unresolved-blocks",
              leftStart: a,
              leftEnd: b,
              rightStart: c,
              rightEnd: d,
            });
          } else {
            let prevL = a;
            let prevR = c;
            for (const [li, rj] of fallbackAnchors) {
              visitBlocks(prevL, li, prevR, rj);
              blockSteps.push({ type: "equal-block", leftBlock: li, rightBlock: rj });
              prevL = li + 1;
              prevR = rj + 1;
            }
            visitBlocks(prevL, b, prevR, d);
          }
        }
      }
    }

    for (let idx = suffix.length - 1; idx >= 0; idx--) {
      const [li, rj] = suffix[idx]!;
      blockSteps.push({ type: "equal-block", leftBlock: li, rightBlock: rj });
    }
  };

  visitBlocks(0, blocksL.length, 0, blocksR.length);
  return blockSteps;
}
