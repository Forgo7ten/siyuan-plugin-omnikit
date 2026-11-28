import type { SemanticUnit } from "./types.ts";

export const EMPTY_SKETCH = new Uint32Array(0);
const MAX_SKETCH_WINDOWS = 512;

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

export interface BlockGroup {
  kind: string;
  context: string;
  containerPath: string;
  subtype: string;
  codeLang: string;
  startUnitIndex: number;
  units: SemanticUnit[];
  unitKeys: string[];
  reliable: boolean;
  exactSignature: string;
  meaningfulLines: string[];
  sortedMeaningfulLines: string[];
  joinedNormalizedText: string;
  headingCoreText: string;
  sketch: Uint32Array;
}

export function normalizeWhitespace(value: string): string {
  return value.trim().replace(/\s+/g, " ");
}

export function isLowEntropyCodeLine(trimmed: string): boolean {
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

/**
 * Extracts a sorted `Uint32Array` multiset sketch of compact 2-character hashes
 * `(((c0 << 16) | c1) >>> 0)` (or single code point when `length === 1`), uniformly
 * sampled up to `MAX_SKETCH_WINDOWS` windows so per-block cost is strictly bounded.
 */
export function buildCompactBigramSketch(text: string): Uint32Array {
  const len = text.length;
  if (len === 0) return EMPTY_SKETCH;
  if (len === 1) {
    return new Uint32Array([text.charCodeAt(0) >>> 0]);
  }
  const totalWindows = len - 1;
  if (totalWindows <= MAX_SKETCH_WINDOWS) {
    const out = new Uint32Array(totalWindows);
    for (let i = 0; i < totalWindows; i++) {
      out[i] = ((text.charCodeAt(i) << 16) | text.charCodeAt(i + 1)) >>> 0;
    }
    out.sort();
    return out;
  }
  const out = new Uint32Array(MAX_SKETCH_WINDOWS);
  for (let k = 0; k < MAX_SKETCH_WINDOWS; k++) {
    const idx = Math.floor((k * totalWindows) / MAX_SKETCH_WINDOWS);
    out[k] = ((text.charCodeAt(idx) << 16) | text.charCodeAt(idx + 1)) >>> 0;
  }
  out.sort();
  return out;
}

/**
 * Extracts a sorted `Uint32Array` multiset sketch of 4-character rolling hashes
 * `((c0 * 29791 + c1 * 961 + c2 * 31 + c3) >>> 0)` for code blocks, falling back to
 * 2-character hashes for 2..3-character snippets and code points for 1-character snippets.
 */
export function buildCodeFourgramSketch(text: string): Uint32Array {
  const len = text.length;
  if (len === 0) return EMPTY_SKETCH;
  if (len < 4) return buildCompactBigramSketch(text);
  const totalWindows = len - 3;
  if (totalWindows <= MAX_SKETCH_WINDOWS) {
    const out = new Uint32Array(totalWindows);
    for (let i = 0; i < totalWindows; i++) {
      const c0 = text.charCodeAt(i);
      const c1 = text.charCodeAt(i + 1);
      const c2 = text.charCodeAt(i + 2);
      const c3 = text.charCodeAt(i + 3);
      out[i] = (c0 * 29791 + c1 * 961 + c2 * 31 + c3) >>> 0;
    }
    out.sort();
    return out;
  }
  const out = new Uint32Array(MAX_SKETCH_WINDOWS);
  for (let k = 0; k < MAX_SKETCH_WINDOWS; k++) {
    const idx = Math.floor((k * totalWindows) / MAX_SKETCH_WINDOWS);
    const c0 = text.charCodeAt(idx);
    const c1 = text.charCodeAt(idx + 1);
    const c2 = text.charCodeAt(idx + 2);
    const c3 = text.charCodeAt(idx + 3);
    out[k] = (c0 * 29791 + c1 * 961 + c2 * 31 + c3) >>> 0;
  }
  out.sort();
  return out;
}

/**
 * Zero-allocation exact multiset Dice coefficient `2 * hit / (a.length + b.length)`
 * via linear two-pointer merge over two sorted `Uint32Array` sketches.
 */
export function sortedMultisetDice(a: Uint32Array, b: Uint32Array): number {
  const lenA = a.length;
  const lenB = b.length;
  if (lenA === 0 || lenB === 0) return 0;
  let i = 0;
  let j = 0;
  let hit = 0;
  while (i < lenA && j < lenB) {
    const va = a[i]!;
    const vb = b[j]!;
    if (va === vb) {
      hit++;
      i++;
      j++;
    } else if (va < vb) {
      i++;
    } else {
      j++;
    }
  }
  return (2 * hit) / (lenA + lenB);
}

function sortedStringMultisetOverlap(a: readonly string[], b: readonly string[]): number {
  const lenA = a.length;
  const lenB = b.length;
  if (lenA === 0 || lenB === 0) return 0;
  let i = 0;
  let j = 0;
  let hit = 0;
  while (i < lenA && j < lenB) {
    const va = a[i]!;
    const vb = b[j]!;
    if (va === vb) {
      hit++;
      i++;
      j++;
    } else if (va < vb) {
      i++;
    } else {
      j++;
    }
  }
  return hit;
}

export function buildBlockGroups(
  units: readonly SemanticUnit[],
  unitKeys: readonly string[],
): BlockGroup[] {
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
    const formatParts = first.format.split("|");
    const subtype = formatParts[0] ?? "";
    const codeLang = kind === "NodeCodeBlock" ? (formatParts[1] ?? "").trim().toLowerCase() : "";
    const normalizedLines = blockUnits.map(u => normalizeWhitespace(u.text));
    const nonEmptyLines = normalizedLines.filter(line => line.length > 0);
    const tableBodyLines =
      kind === "NodeTableRow" && normalizedLines.length > 1
        ? normalizedLines.slice(1).filter(line => line.length > 0)
        : [];
    const meaningfulLines =
      kind === "NodeCodeBlock"
        ? normalizedLines.filter(line => !isLowEntropyCodeLine(line))
        : tableBodyLines.length > 0
          ? tableBodyLines
          : nonEmptyLines;
    const sortedMeaningfulLines =
      meaningfulLines.length > 1 ? [...meaningfulLines].sort() : meaningfulLines;
    const joinedNormalizedText = nonEmptyLines.join("\n");
    const headingCoreText =
      kind === "NodeHeading"
        ? joinedNormalizedText.replace(HEADING_NUMBER_PREFIX_RE, "").trim()
        : "";

    const sketch =
      kind === "NodeCodeBlock"
        ? buildCodeFourgramSketch(meaningfulLines.join("\n"))
        : kind === "NodeTableRow"
          ? buildCompactBigramSketch(meaningfulLines.join("\n"))
          : kind === "NodeHeading"
            ? buildCompactBigramSketch(headingCoreText || joinedNormalizedText)
            : buildCompactBigramSketch(joinedNormalizedText);

    groups.push({
      kind,
      context: first.context,
      containerPath: extractContainerKindPath(first.context, kind),
      subtype,
      codeLang,
      startUnitIndex: start,
      units: blockUnits,
      unitKeys: blockKeys,
      reliable,
      exactSignature: JSON.stringify(blockKeys),
      meaningfulLines,
      sortedMeaningfulLines,
      joinedNormalizedText,
      headingCoreText,
      sketch,
    });
  }
  return groups;
}

export function isBlockStrictlyEqual(a: BlockGroup, b: BlockGroup): boolean {
  return (
    a.reliable &&
    b.reliable &&
    a.unitKeys.length === b.unitKeys.length &&
    a.exactSignature === b.exactSignature
  );
}

export function exactBlockMatchWeight(group: BlockGroup): number {
  return 1000 + 60 * Math.max(1, group.meaningfulLines.length);
}

export function isMeaningfulBlockAnchor(group: BlockGroup): boolean {
  return (
    group.reliable &&
    group.meaningfulLines.length > 0 &&
    group.joinedNormalizedText.length >= 2
  );
}

export function areBlockContainersCompatible(left: BlockGroup, right: BlockGroup): boolean {
  if (!left.reliable || !right.reliable || left.kind !== right.kind) return false;
  if (
    left.kind === "NodeCodeBlock" &&
    (DIAGRAM_CODE_SUBTYPES.has(left.subtype) || DIAGRAM_CODE_SUBTYPES.has(right.subtype)) &&
    left.subtype !== right.subtype
  ) {
    return false;
  }
  return left.containerPath === right.containerPath || left.kind === "NodeParagraph";
}

export function scoreModifiedBlockPair(
  left: BlockGroup,
  right: BlockGroup,
  isIsolatedOneToOne: boolean,
): number {
  if (!areBlockContainersCompatible(left, right)) return 0;
  const sameContainer = left.containerPath === right.containerPath;

  if (left.kind === "NodeCodeBlock") {
    const totalMeaningful = left.meaningfulLines.length + right.meaningfulLines.length;
    const commonLines =
      totalMeaningful > 0
        ? sortedStringMultisetOverlap(left.sortedMeaningfulLines, right.sortedMeaningfulLines)
        : 0;
    const lineOverlap = totalMeaningful > 0 ? (2 * commonLines) / totalMeaningful : 0;
    const codeSketchSim = sortedMultisetDice(left.sketch, right.sketch);
    if (lineOverlap >= 0.25 || codeSketchSim >= 0.30) {
      const sim = Math.max(lineOverlap, codeSketchSim * 0.9);
      return Math.round(300 + 550 * sim) + 50 * commonLines;
    }
    const langCompatible = !left.codeLang || !right.codeLang || left.codeLang === right.codeLang;
    if (isIsolatedOneToOne && sameContainer && langCompatible) {
      return 120;
    }
    return 0;
  }

  if (left.kind === "NodeHeading") {
    if (left.headingCoreText.length > 0 && left.headingCoreText === right.headingCoreText) {
      return 880;
    }
    const sim = sortedMultisetDice(left.sketch, right.sketch);
    if (sim >= 0.35) {
      return Math.round(300 + 550 * sim);
    }
    if (isIsolatedOneToOne && left.subtype === right.subtype) {
      return 120;
    }
    return 0;
  }

  if (left.kind === "NodeTableRow") {
    const commonRows = sortedStringMultisetOverlap(
      left.sortedMeaningfulLines,
      right.sortedMeaningfulLines,
    );
    const denom = Math.max(1, left.meaningfulLines.length + right.meaningfulLines.length);
    const rowSim = (2 * commonRows) / denom;
    const sketchSim = sortedMultisetDice(left.sketch, right.sketch);
    if (rowSim >= 0.25 || sketchSim >= 0.35) {
      const sim = Math.max(rowSim, sketchSim * 0.9);
      return Math.round(220 + 600 * sim) + 30 * commonRows;
    }
    return isIsolatedOneToOne && sameContainer ? 120 : 0;
  }

  // `NodeParagraph` and single-unit atomic blocks (`NodeVideo`, `NodeHTMLBlock`, `NodeAttributeView`, etc.)
  if (left.joinedNormalizedText.length > 0 && left.joinedNormalizedText === right.joinedNormalizedText) {
    return sameContainer ? 920 : 720;
  }

  let sim = sortedMultisetDice(left.sketch, right.sketch);
  if (left.joinedNormalizedText.length > 2400 || right.joinedNormalizedText.length > 2400) {
    const lineSim =
      (2 * sortedStringMultisetOverlap(left.sortedMeaningfulLines, right.sortedMeaningfulLines)) /
      Math.max(1, left.meaningfulLines.length + right.meaningfulLines.length);
    sim = Math.max(sim, lineSim);
  }

  if (!sameContainer) {
    return sim >= 0.75 ? Math.round(250 + 500 * sim) : 0;
  }
  if (sim >= 0.15) {
    return Math.round(200 + 700 * sim);
  }
  return isIsolatedOneToOne ? 80 : 0;
}
