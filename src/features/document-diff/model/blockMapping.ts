import type { DiffHunk, DiffResult, MatchAnchor, SemanticUnit, Side } from "./types.ts";

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

export interface CrossDiffMappingContext {
  readonly diff: DiffResult;
  readonly leftUnits: readonly SemanticUnit[];
  readonly rightUnits: readonly SemanticUnit[];
  readonly leftRootIndexByBlockID: ReadonlyMap<string, number>;
  readonly rightRootIndexByBlockID: ReadonlyMap<string, number>;
  readonly leftRootBlockIDs: readonly string[];
  readonly rightRootBlockIDs: readonly string[];
}

export interface MappedTargetBlock {
  targetBlockID?: string;
  targetRootIndex: number;
  mappingKind: string;
}

export interface DisjointSliceStartParams {
  targetRootIndex: number;
  totalRootBlocks: number;
  windowSize: number;
  minRootIndex: number;
  maxRootIndex: number;
}

/**
 * Pure cross-side block locator: maps a source block `(fromSide, sourceBlockID, sourceRootIndex)`
 * to its opposite-pane counterpart `(targetBlockID, targetRootIndex, mappingKind)` using exact
 * matches, paired diff hunks, nearest matched anchors, or root-block ordinal ratio.
 */
export function mapBlockAcrossDiff(
  ctx: CrossDiffMappingContext,
  fromSide: Side,
  sourceBlockID: string,
  sourceRootIndex?: number,
): MappedTargetBlock | undefined {
  const toSide: Side = fromSide === "left" ? "right" : "left";
  const ownUnits = fromSide === "left" ? ctx.leftUnits : ctx.rightUnits;
  const otherUnits = fromSide === "left" ? ctx.rightUnits : ctx.leftUnits;
  const ownRootMap = fromSide === "left" ? ctx.leftRootIndexByBlockID : ctx.rightRootIndexByBlockID;
  const otherRootMap = fromSide === "left" ? ctx.rightRootIndexByBlockID : ctx.leftRootIndexByBlockID;
  const ownRootIDs = fromSide === "left" ? ctx.leftRootBlockIDs : ctx.rightRootBlockIDs;
  const otherRootIDs = fromSide === "left" ? ctx.rightRootBlockIDs : ctx.leftRootBlockIDs;
  if (otherRootIDs.length === 0 && otherUnits.length === 0) return undefined;

  const resolveTargetRootIndex = (targetBlockID?: string, fallbackRatio = 0): number => {
    if (targetBlockID) {
      const mapped = otherRootMap.get(targetBlockID);
      if (mapped !== undefined) return mapped;
    }
    if (otherRootIDs.length === 0) return 1;
    return Math.max(1, Math.min(otherRootIDs.length, Math.round(fallbackRatio * otherRootIDs.length) || 1));
  };

  const srcRootIdx = sourceRootIndex ?? ownRootMap.get(sourceBlockID) ?? 1;
  const ratio = ownRootIDs.length > 1 ? (srcRootIdx - 1) / (ownRootIDs.length - 1) : 0;

  // 1. Direct matched block in `diff.matches`
  for (const match of ctx.diff.matches) {
    const ownID = fromSide === "left" ? match.leftBlockID : match.rightBlockID;
    const peerID = fromSide === "left" ? match.rightBlockID : match.leftBlockID;
    if (ownID === sourceBlockID && peerID) {
      return {
        targetBlockID: peerID,
        targetRootIndex: resolveTargetRootIndex(peerID, ratio),
        mappingKind: "exact-match",
      };
    }
  }

  // 2. Paired unit or context match for a diff hunk containing `sourceBlockID`
  for (const hunk of ctx.diff.hunks) {
    const ownHunkUnits = fromSide === "left" ? hunk.left : hunk.right;
    const peerHunkUnits = fromSide === "left" ? hunk.right : hunk.left;
    const unitOffset = ownHunkUnits.findIndex(u => u.blockID === sourceBlockID);
    if (unitOffset >= 0) {
      if (hunk.pairedUnits) {
        const explicitPair = hunk.pairedUnits.find(p =>
          (fromSide === "left" ? p.leftIndex : p.rightIndex) === unitOffset,
        );
        if (explicitPair) {
          const explicitPeerIdx = fromSide === "left" ? explicitPair.rightIndex : explicitPair.leftIndex;
          const explicitPeerID = peerHunkUnits[explicitPeerIdx]?.blockID;
          if (explicitPeerID) {
            return {
              targetBlockID: explicitPeerID,
              targetRootIndex: resolveTargetRootIndex(explicitPeerID, ratio),
              mappingKind: `hunk-${hunk.kind}`,
            };
          }
        }
      }
      if (peerHunkUnits.length > 0) {
        const peerIdx = Math.min(
          peerHunkUnits.length - 1,
          Math.floor((unitOffset / Math.max(1, ownHunkUnits.length)) * peerHunkUnits.length),
        );
        const peerID = peerHunkUnits[peerIdx]?.blockID;
        if (peerID) {
          return {
            targetBlockID: peerID,
            targetRootIndex: resolveTargetRootIndex(peerID, ratio),
            mappingKind: `hunk-${hunk.kind}`,
          };
        }
      }
      const contextID = findNearestMatchedBlockID(ctx.diff.matches, hunk, toSide);
      if (contextID) {
        return {
          targetBlockID: contextID,
          targetRootIndex: resolveTargetRootIndex(contextID, ratio),
          mappingKind: `hunk-context-${hunk.kind}`,
        };
      }
    }
  }

  // 3. Nearest matched anchor by logical unit position or root block index
  let srcUnitIndex = ownUnits.findIndex(u => u.blockID === sourceBlockID);
  if (srcUnitIndex < 0 && ownUnits.length > 0) {
    srcUnitIndex = Math.round(ratio * (ownUnits.length - 1));
  }
  if (srcUnitIndex >= 0 && ctx.diff.matches.length > 0) {
    let bestMatch = ctx.diff.matches[0]!;
    let bestDist = Number.POSITIVE_INFINITY;
    for (const m of ctx.diff.matches) {
      const pos = fromSide === "left" ? m.leftIndex : m.rightIndex;
      const peerID = fromSide === "left" ? m.rightBlockID : m.leftBlockID;
      if (!peerID) continue;
      const dist = Math.abs(pos - srcUnitIndex);
      if (dist < bestDist) {
        bestDist = dist;
        bestMatch = m;
      }
    }
    const peerID = fromSide === "left" ? bestMatch.rightBlockID : bestMatch.leftBlockID;
    if (peerID) {
      return {
        targetBlockID: peerID,
        targetRootIndex: resolveTargetRootIndex(peerID, ratio),
        mappingKind: "nearest-match",
      };
    }
  }

  // 4. Proportional root-block fallback
  const targetRootIndex = resolveTargetRootIndex(undefined, ratio);
  const targetBlockID = otherRootIDs[targetRootIndex - 1] ?? otherUnits[0]?.blockID;
  return {
    targetBlockID,
    targetRootIndex,
    mappingKind: "proportional-root",
  };
}

/**
 * Computes the 1-based root block slider start index for a disjoint virtualized slice jump,
 * reserving leading context blocks while clamping within `[1, totalRootBlocks]`.
 */
export function computeDisjointSliceStartIndex(params: DisjointSliceStartParams): number {
  const { targetRootIndex, totalRootBlocks, windowSize, minRootIndex, maxRootIndex } = params;
  const mountedSpan =
    maxRootIndex >= minRootIndex && minRootIndex > 0
      ? maxRootIndex - minRootIndex + 1
      : windowSize;
  const effectiveSliceSize = Math.max(4, Math.min(windowSize, mountedSpan));
  const leadBlocks = Math.max(2, Math.min(8, Math.floor(effectiveSliceSize / 4)));
  const boundedTotal = Math.max(1, totalRootBlocks, targetRootIndex);
  return Math.max(1, Math.min(boundedTotal, targetRootIndex - leadBlocks));
}

export function classifyAdjacentDynamicMode(params: {
  targetRootIndex: number;
  minRootIndex: number;
  maxRootIndex: number;
  topBoundaryLoaded: boolean;
  bottomBoundaryLoaded: boolean;
  windowSize: number;
}): 1 | 2 | null {
  const { targetRootIndex, minRootIndex, maxRootIndex, topBoundaryLoaded, bottomBoundaryLoaded, windowSize } = params;
  const adjacentThreshold = Math.max(6, Math.min(16, Math.floor(windowSize / 4)));
  const isBelowLoaded = maxRootIndex > 0 && targetRootIndex > maxRootIndex;
  const isAboveLoaded = minRootIndex > 0 && targetRootIndex < minRootIndex;
  const distance = isBelowLoaded
    ? targetRootIndex - maxRootIndex
    : isAboveLoaded
      ? minRootIndex - targetRootIndex
      : Number.POSITIVE_INFINITY;
  if (distance > adjacentThreshold) return null;
  if (isBelowLoaded && !bottomBoundaryLoaded) return 2;
  if (isAboveLoaded && !topBoundaryLoaded) return 1;
  return null;
}

/**
 * Resolves the target block and 1-based root ordinal on `side` when jumping to `hunk`.
 */
export function resolveHunkTargetForSide(
  ctx: Pick<CrossDiffMappingContext, "diff" | "leftRootIndexByBlockID" | "rightRootIndexByBlockID">,
  hunk: DiffHunk,
  side: Side,
): { targetBlockID: string; targetRootIndex: number; tableRowIndex?: number } | undefined {
  const sideUnits = side === "left" ? hunk.left : hunk.right;
  const ownUnit = sideUnits[0];
  const targetBlockID =
    ownUnit?.blockID ?? findNearestMatchedBlockID(ctx.diff.matches, hunk, side);
  if (!targetBlockID) return undefined;
  const rootIndexMap = side === "left" ? ctx.leftRootIndexByBlockID : ctx.rightRootIndexByBlockID;
  return {
    targetBlockID,
    targetRootIndex: rootIndexMap.get(targetBlockID) ?? 1,
    tableRowIndex: ownUnit?.tableRowIndex,
  };
}
