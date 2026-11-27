import {
  areBlockContainersCompatible,
  exactBlockMatchWeight,
  isBlockStrictlyEqual,
  isMeaningfulBlockAnchor,
  scoreModifiedBlockPair,
  type BlockGroup,
} from "./blockSimilarity.ts";

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
const EXACT_CANDIDATE_CAP = 8;
const INVERTED_TOPK_CAP = 8;
const DIAGONAL_BAND_RADIUS = 4;

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

function estimatePairMergeOps(gL: BlockGroup, gR: BlockGroup): number {
  if (!areBlockContainersCompatible(gL, gR)) return 1;
  return (
    gL.sketch.length +
    gR.sketch.length +
    gL.sortedMeaningfulLines.length +
    gR.sortedMeaningfulLines.length
  );
}

function isBetterChainHead(
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

function emitChainSteps(
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

  while (curEdge >= 0) {
    const matchI = edgeIList[curEdge]!;
    const matchJ = edgeJList[curEdge]!;
    if (matchI < curI || matchJ < curJ) {
      return false;
    }
    while (curI < matchI) {
      outSteps.push({ type: "left-block", leftBlock: a + curI++ });
    }
    while (curJ < matchJ) {
      outSteps.push({ type: "right-block", rightBlock: c + curJ++ });
    }
    if (edgeExactList[curEdge] === 1) {
      outSteps.push({ type: "equal-block", leftBlock: a + matchI, rightBlock: c + matchJ });
    } else {
      outSteps.push({ type: "paired-block", leftBlock: a + matchI, rightBlock: c + matchJ });
    }
    curI = matchI + 1;
    curJ = matchJ + 1;
    curEdge = edgeNextList[curEdge]!;
  }

  while (curI < n) {
    outSteps.push({ type: "left-block", leftBlock: a + curI++ });
  }
  while (curJ < m) {
    outSteps.push({ type: "right-block", rightBlock: c + curJ++ });
  }
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

function selectNearestExactIndices(
  sortedIndices: readonly number[],
  centerJ: number,
  cap: number,
  addCandidate: (j: number) => void,
): number {
  const len = sortedIndices.length;
  if (len <= cap) {
    for (let k = 0; k < len; k++) addCandidate(sortedIndices[k]!);
    return len;
  }
  let lo = 0;
  let hi = len;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (sortedIndices[mid]! < centerJ) lo = mid + 1;
    else hi = mid;
  }
  let leftPtr = lo - 1;
  let rightPtr = lo;
  let picked = 0;
  while (picked < cap && (leftPtr >= 0 || rightPtr < len)) {
    if (leftPtr < 0) {
      addCandidate(sortedIndices[rightPtr++]!);
    } else if (rightPtr >= len) {
      addCandidate(sortedIndices[leftPtr--]!);
    } else {
      const distL = centerJ - sortedIndices[leftPtr]!;
      const distR = sortedIndices[rightPtr]! - centerJ;
      if (distL <= distR) addCandidate(sortedIndices[leftPtr--]!);
      else addCandidate(sortedIndices[rightPtr++]!);
    }
    picked++;
  }
  return picked + 8;
}

/**
 * Sparse 3-channel candidate generation + two-phase Suffix Maximum Fenwick Tree solver
 * guaranteeing strictly monotone `(i_1 < i_2 < ... && j_1 < j_2 < ...)` block pairings.
 */
export function emitSparseBlockFenwickDP(
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
  if (n === 0) {
    for (let j = c; j < d; j++) outSteps.push({ type: "right-block", rightBlock: j });
    return true;
  }
  if (m === 0) {
    for (let i = a; i < b; i++) outSteps.push({ type: "left-block", leftBlock: i });
    return true;
  }

  let segmentCells = 0;
  let opRemainder = 0;
  const consumeCells = (cells: number): boolean => {
    if (cells <= 0) return true;
    if (segmentCells + cells > budget.maxCells || cells > budget.remaining) {
      budget.remaining = Math.max(0, budget.remaining - cells);
      return false;
    }
    segmentCells += cells;
    budget.remaining -= cells;
    return true;
  };
  const consumeOps = (ops: number): boolean => {
    if (ops <= 0) return true;
    opRemainder += ops;
    if (opRemainder < 4) return true;
    const extra = opRemainder >> 2;
    opRemainder &= 3;
    return consumeCells(extra);
  };

  if (!consumeCells(n + m)) return false;

  // Pre-build right-side exact signature lookup and frequency-capped inverted sketch postings.
  const maxDf = Math.min(48, Math.max(12, Math.floor(m * 0.25)));
  const exactRightBySig = new Map<string, number[]>();
  const postings = new Map<number, number[]>();

  for (let j = 0; j < m; j++) {
    const gR = blocksR[c + j]!;
    if (gR.reliable) {
      let sigList = exactRightBySig.get(gR.exactSignature);
      if (!sigList) {
        sigList = [];
        exactRightBySig.set(gR.exactSignature, sigList);
      }
      sigList.push(j);
    }

    const sketch = gR.sketch;
    if (!consumeOps(sketch.length + 1)) return false;
    for (let t = 0; t < sketch.length; t++) {
      const feat = sketch[t]!;
      if (t > 0 && feat === sketch[t - 1]!) continue;
      let list = postings.get(feat);
      if (!list) {
        list = [j];
        postings.set(feat, list);
      } else if (list.length <= maxDf) {
        list.push(j);
      }
    }
  }

  // Suffix-Max Fenwick tree over `j in 0..m-1` mapped to 1-based `idx = m - j`.
  const treeScore = new Float64Array(m + 1);
  const treeI = new Int32Array(m + 1).fill(n + 1);
  const treeJ = new Int32Array(m + 1).fill(m + 1);
  const treeEdge = new Int32Array(m + 1).fill(-1);

  let qBestScore = 0;
  let qBestI = n + 1;
  let qBestJ = m + 1;
  let qBestEdge = -1;

  const querySuffix = (minJ: number): void => {
    qBestScore = 0;
    qBestI = n + 1;
    qBestJ = m + 1;
    qBestEdge = -1;
    if (minJ >= m) return;
    let idx = m - (minJ < 0 ? 0 : minJ);
    while (idx > 0) {
      const nodeEdge = treeEdge[idx]!;
      if (
        nodeEdge >= 0 &&
        isBetterChainHead(
          treeScore[idx]!,
          treeI[idx]!,
          treeJ[idx]!,
          qBestScore,
          qBestI,
          qBestJ,
        )
      ) {
        qBestScore = treeScore[idx]!;
        qBestI = treeI[idx]!;
        qBestJ = treeJ[idx]!;
        qBestEdge = nodeEdge;
      }
      idx -= idx & -idx;
    }
  };

  const updateAt = (j: number, totalScore: number, edgeI: number, edgeJ: number, edgeId: number): void => {
    let idx = m - j;
    while (idx <= m) {
      if (
        treeEdge[idx]! < 0 ||
        isBetterChainHead(totalScore, edgeI, edgeJ, treeScore[idx]!, treeI[idx]!, treeJ[idx]!)
      ) {
        treeScore[idx] = totalScore;
        treeI[idx] = edgeI;
        treeJ[idx] = edgeJ;
        treeEdge[idx] = edgeId;
      }
      idx += idx & -idx;
    }
  };

  const isOneToOneGap = n === 1 && m === 1;
  const candidateStamp = new Int32Array(m);
  const hitStamp = new Int32Array(m);
  const hitCounts = new Uint16Array(m);
  const touchedJs: number[] = [];
  const candidateJs: number[] = [];

  const edgeIList: number[] = [];
  const edgeJList: number[] = [];
  const edgeExactList: number[] = [];
  const edgeNextList: number[] = [];

  const rowJ: number[] = [];
  const rowTotalScore: number[] = [];
  const rowExact: number[] = [];
  const rowNextEdge: number[] = [];

  for (let i = n - 1; i >= 0; i--) {
    const gL = blocksL[a + i]!;
    const stamp = n - i;
    candidateJs.length = 0;
    touchedJs.length = 0;

    const addCandidate = (j: number): void => {
      if (candidateStamp[j] !== stamp) {
        candidateStamp[j] = stamp;
        candidateJs.push(j);
      }
    };

    const centerJ = Math.round((i * Math.max(0, m - 1)) / Math.max(1, n - 1));

    // Channel 1: Repeated exact match blocks passthrough (up to 8 nearest to `centerJ`).
    if (gL.reliable) {
      const exactList = exactRightBySig.get(gL.exactSignature);
      if (exactList !== undefined && exactList.length > 0) {
        const ops = selectNearestExactIndices(exactList, centerJ, EXACT_CANDIDATE_CAP, addCandidate);
        if (!consumeOps(ops)) return false;
      }
    }

    // Channel 2: Non-high-frequency sketch inverted index Top-K (`K = 8`).
    const sketchL = gL.sketch;
    if (!consumeOps(sketchL.length)) return false;
    for (let t = 0; t < sketchL.length; t++) {
      const feat = sketchL[t]!;
      if (t > 0 && feat === sketchL[t - 1]!) continue;
      const list = postings.get(feat);
      if (!list || list.length > maxDf) continue;
      if (!consumeOps(list.length)) return false;
      for (let p = 0; p < list.length; p++) {
        const j = list[p]!;
        if (blocksR[c + j]!.kind !== gL.kind) continue;
        if (hitStamp[j] !== stamp) {
          hitStamp[j] = stamp;
          hitCounts[j] = 1;
          touchedJs.push(j);
        } else {
          hitCounts[j]!++;
        }
      }
    }

    if (touchedJs.length <= INVERTED_TOPK_CAP) {
      for (let k = 0; k < touchedJs.length; k++) addCandidate(touchedJs[k]!);
    } else {
      if (!consumeOps(touchedJs.length * INVERTED_TOPK_CAP)) return false;
      for (let pick = 0; pick < INVERTED_TOPK_CAP; pick++) {
        let bestPos = pick;
        let bestJ = touchedJs[pick]!;
        let bestHits = hitCounts[bestJ]!;
        let bestDist = Math.abs(bestJ - centerJ);
        for (let k = pick + 1; k < touchedJs.length; k++) {
          const candJ = touchedJs[k]!;
          const candHits = hitCounts[candJ]!;
          const candDist = Math.abs(candJ - centerJ);
          if (
            candHits > bestHits ||
            (candHits === bestHits && (candDist < bestDist || (candDist === bestDist && candJ < bestJ)))
          ) {
            bestPos = k;
            bestJ = candJ;
            bestHits = candHits;
            bestDist = candDist;
          }
        }
        touchedJs[bestPos] = touchedJs[pick]!;
        touchedJs[pick] = bestJ;
        addCandidate(bestJ);
      }
    }

    // Channel 3: Local proportional diagonal band `[centerJ - 4 .. centerJ + 4]`.
    const bandStart = Math.max(0, centerJ - DIAGONAL_BAND_RADIUS);
    const bandEnd = Math.min(m - 1, centerJ + DIAGONAL_BAND_RADIUS);
    if (!consumeOps(bandEnd - bandStart + 1)) return false;
    for (let j = bandStart; j <= bandEnd; j++) {
      if (areBlockContainersCompatible(gL, blocksR[c + j]!)) {
        addCandidate(j);
      }
    }

    if (candidateJs.length === 0) continue;
    candidateJs.sort((x, y) => x - y);

    // Phase A (read-only query): evaluate candidate weights and query `j + 1 .. m - 1` without mutating tree.
    rowJ.length = 0;
    rowTotalScore.length = 0;
    rowExact.length = 0;
    rowNextEdge.length = 0;

    for (let k = 0; k < candidateJs.length; k++) {
      const j = candidateJs[k]!;
      const gR = blocksR[c + j]!;
      let weight = 0;
      let exactFlag = 0;
      if (isBlockStrictlyEqual(gL, gR)) {
        weight = exactBlockMatchWeight(gL);
        exactFlag = 1;
      } else {
        if (!consumeOps(estimatePairMergeOps(gL, gR))) return false;
        weight = scoreModifiedBlockPair(gL, gR, isOneToOneGap);
      }
      if (weight <= 0) continue;

      if (!consumeOps(4)) return false;
      querySuffix(j + 1);
      rowJ.push(j);
      rowTotalScore.push(weight + qBestScore);
      rowExact.push(exactFlag);
      rowNextEdge.push(qBestEdge);
    }

    // Phase B (batch write): commit all positive-weight edges of row `i` into Fenwick tree.
    for (let k = 0; k < rowJ.length; k++) {
      const j = rowJ[k]!;
      const edgeId = edgeIList.length;
      edgeIList.push(i);
      edgeJList.push(j);
      edgeExactList.push(rowExact[k]!);
      edgeNextList.push(rowNextEdge[k]!);
      updateAt(j, rowTotalScore[k]!, i, j, edgeId);
    }
  }

  querySuffix(0);
  return emitChainSteps(
    edgeIList,
    edgeJList,
    edgeExactList,
    edgeNextList,
    qBestEdge,
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
