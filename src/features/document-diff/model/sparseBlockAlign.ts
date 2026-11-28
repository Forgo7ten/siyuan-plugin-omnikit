import {
  emitChainSteps,
  estimatePairMergeOps,
  isBetterChainHead,
  type BlockAlignBudget,
  type BlockAlignStep,
} from "./blockAlign.ts";
import {
  areBlockContainersCompatible,
  exactBlockMatchWeight,
  isBlockStrictlyEqual,
  scoreModifiedBlockPair,
  type BlockGroup,
} from "./blockSimilarity.ts";

const EXACT_CANDIDATE_CAP = 8;
const INVERTED_TOPK_CAP = 8;
const DIAGONAL_BAND_RADIUS = 4;

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

function selectTopInvertedCandidates(
  touchedJs: number[],
  hitCounts: Uint16Array,
  centerJ: number,
  cap: number,
  addCandidate: (j: number) => void,
): void {
  if (touchedJs.length <= cap) {
    for (let k = 0; k < touchedJs.length; k++) addCandidate(touchedJs[k]!);
    return;
  }
  for (let pick = 0; pick < cap; pick++) {
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

    // Channel 2: Non-high-frequency sketch inverted index Top-K (`K = 8`) with container compatibility filtering.
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
        if (!areBlockContainersCompatible(gL, blocksR[c + j]!)) continue;
        if (hitStamp[j] !== stamp) {
          hitStamp[j] = stamp;
          hitCounts[j] = 1;
          touchedJs.push(j);
        } else {
          hitCounts[j]!++;
        }
      }
    }

    if (touchedJs.length > INVERTED_TOPK_CAP && !consumeOps(touchedJs.length * INVERTED_TOPK_CAP)) {
      return false;
    }
    selectTopInvertedCandidates(touchedJs, hitCounts, centerJ, INVERTED_TOPK_CAP, addCandidate);

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
    blocksL,
    blocksR,
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
