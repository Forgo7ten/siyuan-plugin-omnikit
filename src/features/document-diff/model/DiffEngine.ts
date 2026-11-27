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

const DIAGRAM_CODE_SUBTYPES = new Set([
  "mermaid",
  "echarts",
  "plantuml",
  "graphviz",
  "flowchart",
  "abc",
  "mindmap",
]);

const CONTAINER_TYPE_RE =
  /\b(NodeList|NodeListItem|NodeBlockquote|NodeCallout|NodeSuperBlock|NodeTabs|NodeTabItem|NodeMindmap|NodeMindmapItem)\b/g;

const HEADING_NUMBER_PREFIX_RE =
  /^(?:第[一二三四五六七八九十百零\d]+[章节部分条篇]\s*|\d+(?:\.\d+)*[.)、．\s]\s*|[①②③④⑤⑥⑦⑧⑨⑩⑪⑫]\s*)/u;

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

function normalizeWhitespace(value: string): string {
  return value.trim().replace(/\s+/g, " ");
}

function isLowEntropyCodeLine(trimmed: string): boolean {
  return trimmed.length === 0 || /^[{}()[\];,]+$/.test(trimmed);
}

function extractContainerKindPath(context: string, kind: string): string {
  if (!context) return kind === "NodeTableRow" ? "Table" : "";
  const parts: string[] = [];
  let match: RegExpExecArray | null;
  CONTAINER_TYPE_RE.lastIndex = 0;
  while ((match = CONTAINER_TYPE_RE.exec(context)) !== null) {
    parts.push(match[1]!);
  }
  if (kind === "NodeTableRow") parts.push("Table");
  return parts.join(">");
}

function diceBigramSimilarity(a: string, b: string): number {
  if (a === b) return a.length > 0 ? 1 : 0;
  if (a.length === 0 || b.length === 0) return 0;
  if (a.length === 1 || b.length === 1) {
    return a.includes(b) || b.includes(a) ? (2 / (a.length + b.length)) : 0;
  }
  const counts = new Map<string, number>();
  const aBigrams = a.length - 1;
  const bBigrams = b.length - 1;
  for (let i = 0; i < aBigrams; i++) {
    const bg = a.slice(i, i + 2);
    counts.set(bg, (counts.get(bg) ?? 0) + 1);
  }
  let intersection = 0;
  for (let j = 0; j < bBigrams; j++) {
    const bg = b.slice(j, j + 2);
    const cur = counts.get(bg);
    if (cur !== undefined && cur > 0) {
      intersection++;
      counts.set(bg, cur - 1);
    }
  }
  return (2 * intersection) / (aBigrams + bBigrams);
}

function multisetOverlapCount(leftItems: readonly string[], rightItems: readonly string[]): number {
  if (leftItems.length === 0 || rightItems.length === 0) return 0;
  const counts = new Map<string, number>();
  for (const item of leftItems) {
    counts.set(item, (counts.get(item) ?? 0) + 1);
  }
  let overlap = 0;
  for (const item of rightItems) {
    const c = counts.get(item);
    if (c !== undefined && c > 0) {
      overlap++;
      counts.set(item, c - 1);
    }
  }
  return overlap;
}

interface BlockGroup {
  kind: string;
  context: string;
  containerPath: string;
  subtype: string;
  startUnitIndex: number;
  units: SemanticUnit[];
  unitKeys: string[];
  reliable: boolean;
  exactSignature: string;
  meaningfulLines: string[];
  joinedNormalizedText: string;
}

function buildBlockGroups(units: readonly SemanticUnit[], unitKeys: readonly string[]): BlockGroup[] {
  const groups: BlockGroup[] = [];
  let i = 0;
  while (i < units.length) {
    const first = units[i]!;
    const start = i;
    const blockUnits: SemanticUnit[] = [first];
    const blockKeys: string[] = [unitKeys[i]!];
    let reliable = first.reliable;
    i++;
    while (
      i < units.length &&
      first.blockID !== undefined &&
      units[i]!.blockID === first.blockID
    ) {
      const cur = units[i]!;
      blockUnits.push(cur);
      blockKeys.push(unitKeys[i]!);
      if (!cur.reliable) reliable = false;
      i++;
    }

    const kind = first.kind;
    const subtype = first.format.split("|", 1)[0] ?? "";
    const normalizedLines = blockUnits.map(u => normalizeWhitespace(u.text));
    const meaningfulLines =
      kind === "NodeCodeBlock"
        ? normalizedLines.filter(line => !isLowEntropyCodeLine(line))
        : normalizedLines.filter(line => line.length > 0);
    const joinedNormalizedText = normalizedLines.filter(Boolean).join("\n");

    groups.push({
      kind,
      context: first.context,
      containerPath: extractContainerKindPath(first.context, kind),
      subtype,
      startUnitIndex: start,
      units: blockUnits,
      unitKeys: blockKeys,
      reliable,
      exactSignature: JSON.stringify(blockKeys),
      meaningfulLines,
      joinedNormalizedText,
    });
  }
  return groups;
}

function isBlockStrictlyEqual(a: BlockGroup, b: BlockGroup): boolean {
  return (
    a.reliable &&
    b.reliable &&
    a.unitKeys.length === b.unitKeys.length &&
    a.exactSignature === b.exactSignature
  );
}

function exactBlockMatchWeight(group: BlockGroup): number {
  return 1000 + 60 * Math.max(1, group.meaningfulLines.length);
}

function hasOpaqueInlineToken(unit: SemanticUnit, tokenPrefix: string): boolean {
  return unit.format.includes(tokenPrefix);
}

function scoreModifiedBlockPair(
  left: BlockGroup,
  right: BlockGroup,
  isIsolatedOneToOne: boolean,
): number {
  if (!left.reliable || !right.reliable) return 0;
  if (left.kind !== right.kind) return 0;

  if (
    left.kind === "NodeCodeBlock" &&
    (DIAGRAM_CODE_SUBTYPES.has(left.subtype) || DIAGRAM_CODE_SUBTYPES.has(right.subtype)) &&
    left.subtype !== right.subtype
  ) {
    return 0;
  }

  const sameContainer = left.containerPath === right.containerPath;
  if (!sameContainer && left.kind !== "NodeParagraph") {
    return 0;
  }

  if (left.kind === "NodeCodeBlock") {
    const totalMeaningful = left.meaningfulLines.length + right.meaningfulLines.length;
    if (totalMeaningful === 0) {
      return isIsolatedOneToOne ? 240 : 0;
    }
    const commonLines = multisetOverlapCount(left.meaningfulLines, right.meaningfulLines);
    const lineOverlap = (2 * commonLines) / totalMeaningful;
    const shortSnippet =
      left.meaningfulLines.length <= 4 &&
      right.meaningfulLines.length <= 4 &&
      left.joinedNormalizedText.length <= 600 &&
      right.joinedNormalizedText.length <= 600;
    const charSim = shortSnippet
      ? diceBigramSimilarity(left.joinedNormalizedText, right.joinedNormalizedText) * 0.85
      : 0;
    const sim = Math.max(lineOverlap, charSim);
    if (sim >= 0.25) {
      return Math.round(300 + 550 * sim) + 50 * commonLines;
    }
    if (isIsolatedOneToOne && sim >= 0.12) {
      return Math.round(200 + 400 * sim);
    }
    return 0;
  }

  if (left.kind === "NodeHeading") {
    const coreL = left.joinedNormalizedText.replace(HEADING_NUMBER_PREFIX_RE, "").trim();
    const coreR = right.joinedNormalizedText.replace(HEADING_NUMBER_PREFIX_RE, "").trim();
    if (coreL.length > 0 && coreL === coreR) {
      return 880;
    }
    const sim = diceBigramSimilarity(
      coreL || left.joinedNormalizedText,
      coreR || right.joinedNormalizedText,
    );
    if (sim >= 0.35) {
      return Math.round(300 + 550 * sim);
    }
    if (isIsolatedOneToOne && left.subtype === right.subtype) {
      return 120;
    }
    return 0;
  }

  if (left.kind === "NodeTableRow") {
    const commonRows = multisetOverlapCount(left.meaningfulLines, right.meaningfulLines);
    const denom = Math.max(1, left.meaningfulLines.length + right.meaningfulLines.length);
    const rowSim = (2 * commonRows) / denom;
    return 220 + Math.round(600 * rowSim) + 30 * commonRows;
  }

  // `NodeParagraph` and single-unit atomic blocks (`NodeVideo`, `NodeHTMLBlock`, `NodeAttributeView`, etc.)
  if (left.joinedNormalizedText.length > 0 && left.joinedNormalizedText === right.joinedNormalizedText) {
    return sameContainer ? 920 : 720;
  }

  const textBounded =
    left.joinedNormalizedText.length <= 2400 && right.joinedNormalizedText.length <= 2400;
  let sim = textBounded
    ? diceBigramSimilarity(left.joinedNormalizedText, right.joinedNormalizedText)
    : (2 * multisetOverlapCount(left.meaningfulLines, right.meaningfulLines)) /
      Math.max(1, left.meaningfulLines.length + right.meaningfulLines.length);

  if (sameContainer && left.units.length === 1 && right.units.length === 1) {
    const uL = left.units[0]!;
    const uR = right.units[0]!;
    if (
      (hasOpaqueInlineToken(uL, "img(") && hasOpaqueInlineToken(uR, "img(")) ||
      (hasOpaqueInlineToken(uL, "inline-math(") && hasOpaqueInlineToken(uR, "inline-math("))
    ) {
      sim = Math.max(sim, 0.6);
    }
  }

  if (!sameContainer) {
    return sim >= 0.75 ? Math.round(250 + 500 * sim) : 0;
  }
  if (sim >= 0.15) {
    return Math.round(200 + 700 * sim);
  }
  return 80;
}

function longestIncreasingSubsequencePairs(pairs: ReadonlyArray<[number, number]>): Array<[number, number]> {
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

type BlockAlignStep =
  | { type: "equal-block"; leftBlock: number; rightBlock: number }
  | { type: "paired-block"; leftBlock: number; rightBlock: number }
  | { type: "left-block"; leftBlock: number }
  | { type: "right-block"; rightBlock: number }
  | { type: "unresolved-blocks"; leftStart: number; leftEnd: number; rightStart: number; rightEnd: number };

type IntraUnitStep =
  | { type: "equal"; leftUnitIndex: number; rightUnitIndex: number }
  | { type: "modified-pair"; leftUnit: SemanticUnit; rightUnit: SemanticUnit }
  | { type: "intra-left"; leftUnit: SemanticUnit }
  | { type: "intra-right"; rightUnit: SemanticUnit }
  | { type: "intra-unresolved"; leftUnits: SemanticUnit[]; rightUnits: SemanticUnit[] };

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
      unresolved: counts.unresolved > 0,
      counts,
    };
  }

  const keysL = left.map(semanticKey);
  const keysR = right.map(semanticKey);
  const blocksL = buildBlockGroups(left, keysL);
  const blocksR = buildBlockGroups(right, keysR);
  const blockSteps: BlockAlignStep[] = [];

  const findUniqueMonotoneBlockAnchors = (
    a: number,
    b: number,
    c: number,
    d: number,
  ): Array<[number, number]> => {
    const leftCounts = new Map<string, number>();
    const leftIdx = new Map<string, number>();
    for (let i = a; i < b; i++) {
      if (!blocksL[i]!.reliable) continue;
      const sig = blocksL[i]!.exactSignature;
      leftCounts.set(sig, (leftCounts.get(sig) ?? 0) + 1);
      leftIdx.set(sig, i);
    }
    const rightCounts = new Map<string, number>();
    const rightIdx = new Map<string, number>();
    for (let j = c; j < d; j++) {
      if (!blocksR[j]!.reliable) continue;
      const sig = blocksR[j]!.exactSignature;
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
  };

  const emitBoundedBlockDP = (a: number, b: number, c: number, d: number): boolean => {
    const n = b - a;
    const m = d - c;
    const width = m + 1;
    if (n + 1 > Math.floor(maxCells / width) || n + 1 > Math.floor(remainingCells / width)) {
      return false;
    }
    const cells = (n + 1) * width;
    remainingCells -= cells;

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
          pairWeights[pIdx] = scoreModifiedBlockPair(gL, gR, isOneToOneGap);
        }
      }
    }

    const dp = new Float64Array(cells);
    for (let i = n - 1; i >= 0; i--) {
      for (let j = m - 1; j >= 0; j--) {
        const idx = i * width + j;
        const down = dp[(i + 1) * width + j]!;
        const across = dp[i * width + j + 1]!;
        let best = down >= across ? down : across;
        const w = pairWeights[i * m + j]!;
        if (w > 0) {
          const diag = dp[(i + 1) * width + j + 1]! + w;
          if (diag >= best) best = diag;
        }
        dp[idx] = best;
      }
    }

    let i = 0;
    let j = 0;
    while (i < n || j < m) {
      if (i < n && j < m) {
        const pIdx = i * m + j;
        const w = pairWeights[pIdx]!;
        if (w > 0 && dp[i * width + j]! === dp[(i + 1) * width + j + 1]! + w) {
          if (pairIsExact[pIdx] === 1) {
            blockSteps.push({ type: "equal-block", leftBlock: a + i, rightBlock: c + j });
          } else {
            blockSteps.push({ type: "paired-block", leftBlock: a + i, rightBlock: c + j });
          }
          i++;
          j++;
          continue;
        }
      }
      if (i < n && (j === m || dp[(i + 1) * width + j]! >= dp[i * width + j + 1]!)) {
        blockSteps.push({ type: "left-block", leftBlock: a + i });
        i++;
      } else {
        blockSteps.push({ type: "right-block", rightBlock: c + j });
        j++;
      }
    }
    return true;
  };

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
    } else if (!emitBoundedBlockDP(a, b, c, d)) {
      const anchors = findUniqueMonotoneBlockAnchors(a, b, c, d);
      if (anchors.length === 0) {
        blockSteps.push({ type: "unresolved-blocks", leftStart: a, leftEnd: b, rightStart: c, rightEnd: d });
      } else {
        let prevL = a;
        let prevR = c;
        for (const [li, rj] of anchors) {
          visitBlocks(prevL, li, prevR, rj);
          blockSteps.push({ type: "equal-block", leftBlock: li, rightBlock: rj });
          prevL = li + 1;
          prevR = rj + 1;
        }
        visitBlocks(prevL, b, prevR, d);
      }
    }
    for (let idx = suffix.length - 1; idx >= 0; idx--) {
      const [li, rj] = suffix[idx]!;
      blockSteps.push({ type: "equal-block", leftBlock: li, rightBlock: rj });
    }
  };

  visitBlocks(0, blocksL.length, 0, blocksR.length);

  const isUnitStrictlyEqual = (li: number, rj: number): boolean =>
    left[li]!.reliable && right[rj]!.reliable && keysL[li] === keysR[rj];

  const computeIntraLinePairWeight = (li: number, rj: number): { weight: number; exact: boolean } => {
    const uL = left[li]!;
    const uR = right[rj]!;
    if (!uL.reliable || !uR.reliable || uL.kind !== uR.kind) {
      return { weight: 0, exact: false };
    }
    if (keysL[li] === keysR[rj]) {
      if (uL.text === "" && uL.kind !== "NodeTableRow") {
        return { weight: 15, exact: true };
      }
      if (uL.kind === "NodeCodeBlock" && isLowEntropyCodeLine(uL.text.trim())) {
        return { weight: 25, exact: true };
      }
      return { weight: 100, exact: true };
    }
    if (uL.text === "" && uR.text === "") {
      return { weight: 12, exact: false };
    }
    if (uL.text === "" || uR.text === "") {
      return { weight: 0, exact: false };
    }
    const normL = normalizeWhitespace(uL.text);
    const normR = normalizeWhitespace(uR.text);
    if (normL.length > 0 && normL === normR) {
      if (uL.kind === "NodeCodeBlock" && isLowEntropyCodeLine(normL)) {
        return { weight: 20, exact: false };
      }
      return { weight: 85, exact: false };
    }
    if (uL.kind === "NodeCodeBlock" && (isLowEntropyCodeLine(normL) || isLowEntropyCodeLine(normR))) {
      return { weight: 0, exact: false };
    }
    if (normL.length <= 400 && normR.length <= 400) {
      const sim = diceBigramSimilarity(normL, normR);
      if (sim >= 0.4) {
        return { weight: Math.round(30 + 45 * sim), exact: false };
      }
    }
    return { weight: 0, exact: false };
  };

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
      const idxL = new Map<string, number>();
      for (let i = a; i < b; i++) {
        const u = left[i]!;
        if (!u.reliable || (u.kind === "NodeCodeBlock" && isLowEntropyCodeLine(u.text.trim())) || u.text === "") {
          continue;
        }
        const k = keysL[i]!;
        countsL.set(k, (countsL.get(k) ?? 0) + 1);
        idxL.set(k, i);
      }
      const countsR = new Map<string, number>();
      const idxR = new Map<string, number>();
      for (let j = c; j < d; j++) {
        const u = right[j]!;
        if (!u.reliable || (u.kind === "NodeCodeBlock" && isLowEntropyCodeLine(u.text.trim())) || u.text === "") {
          continue;
        }
        const k = keysR[j]!;
        countsR.set(k, (countsR.get(k) ?? 0) + 1);
        idxR.set(k, j);
      }
      const pairs: Array<[number, number]> = [];
      for (const [k, cL] of countsL) {
        if (cL === 1 && countsR.get(k) === 1) {
          pairs.push([idxL.get(k)!, idxR.get(k)!]);
        }
      }
      return longestIncreasingSubsequencePairs(pairs);
    };

    const emitWeightedIntraDP = (a: number, b: number, c: number, d: number): boolean => {
      const n = b - a;
      const m = d - c;
      const width = m + 1;
      if (n + 1 > Math.floor(maxCells / width) || n + 1 > Math.floor(remainingCells / width)) {
        return false;
      }
      const cells = (n + 1) * width;
      remainingCells -= cells;

      const weights = new Int16Array(n * m);
      const exactFlags = new Uint8Array(n * m);
      for (let i = 0; i < n; i++) {
        for (let j = 0; j < m; j++) {
          const pIdx = i * m + j;
          const res = computeIntraLinePairWeight(a + i, c + j);
          weights[pIdx] = res.weight;
          exactFlags[pIdx] = res.exact ? 1 : 0;
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
      } else if (!emitWeightedIntraDP(a, b, c, d)) {
        const anchors = findUniqueIntraAnchors(a, b, c, d);
        if (anchors.length === 0) {
          out.push({
            type: "intra-unresolved",
            leftUnits: left.slice(a, b),
            rightUnits: right.slice(c, d),
          });
        } else {
          let prevL = a;
          let prevR = c;
          for (const [li, rj] of anchors) {
            visitUnits(prevL, li, prevR, rj);
            out.push({ type: "equal", leftUnitIndex: li, rightUnitIndex: rj });
            prevL = li + 1;
            prevR = rj + 1;
          }
          visitUnits(prevL, b, prevR, d);
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
