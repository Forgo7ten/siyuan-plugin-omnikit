import type { MatchAnchor, Side } from "./types.ts";

export interface ScrollAnchor {
  leftY: number;
  rightY: number;
}

/**
 * Extracts the longest strictly monotone chain `(leftY_i < leftY_{i+1} && rightY_i < rightY_{i+1})`
 * using LIS so a single out-of-order block does not discard subsequent valid scroll anchors.
 */
export function monotoneAnchors(anchors: readonly ScrollAnchor[]): ScrollAnchor[] {
  const valid = anchors
    .filter(a => Number.isFinite(a.leftY) && Number.isFinite(a.rightY))
    .slice()
    .sort((a, b) => a.leftY - b.leftY || a.rightY - b.rightY);
  if (valid.length === 0) return [];

  // Deduplicate identical or non-increasing leftY entries by keeping the earliest rightY candidate.
  const uniqueLeft: ScrollAnchor[] = [];
  for (const anchor of valid) {
    const prev = uniqueLeft[uniqueLeft.length - 1];
    if (prev && Math.abs(anchor.leftY - prev.leftY) < 0.5) continue;
    uniqueLeft.push(anchor);
  }

  const tails: number[] = [];
  const positions: number[] = [];
  const previous = new Int32Array(uniqueLeft.length).fill(-1);

  for (let i = 0; i < uniqueLeft.length; i++) {
    const rightY = uniqueLeft[i]!.rightY;
    let lo = 0;
    let hi = tails.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (tails[mid]! < rightY - 0.5) lo = mid + 1;
      else hi = mid;
    }
    if (lo > 0) previous[i] = positions[lo - 1]!;
    tails[lo] = rightY;
    positions[lo] = i;
  }

  const result: ScrollAnchor[] = [];
  let idx = positions.length > 0 ? positions[positions.length - 1]! : -1;
  while (idx >= 0) {
    result.push(uniqueLeft[idx]!);
    idx = previous[idx]!;
  }
  result.reverse();
  return result;
}

/**
 * Piecewise linear interpolation between matched content anchors with bounded edge extrapolation.
 */
export function linkedY(
  y: number,
  anchors: readonly ScrollAnchor[],
  from: Side,
  maxExtrapolation = 500,
): number | null {
  if (!Number.isFinite(y) || anchors.length === 0) return null;
  const src = (a: ScrollAnchor) => (from === "left" ? a.leftY : a.rightY);
  const dst = (a: ScrollAnchor) => (from === "left" ? a.rightY : a.leftY);

  let ordered = anchors;
  let needsSort = false;
  for (let i = 1; i < ordered.length; i++) {
    if (src(ordered[i]!) < src(ordered[i - 1]!)) {
      needsSort = true;
      break;
    }
  }
  if (needsSort) {
    ordered = [...anchors].sort((a, b) => src(a) - src(b));
  }
  for (let i = 1; i < ordered.length; i++) {
    if (src(ordered[i]!) <= src(ordered[i - 1]!) || dst(ordered[i]!) <= dst(ordered[i - 1]!)) {
      return null;
    }
  }

  const first = ordered[0]!;
  const last = ordered[ordered.length - 1]!;
  if (y < src(first)) {
    const delta = src(first) - y;
    return delta <= maxExtrapolation ? dst(first) - delta : null;
  }
  if (y > src(last)) {
    const delta = y - src(last);
    return delta <= maxExtrapolation ? dst(last) + delta : null;
  }

  let lo = 0;
  let hi = ordered.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (src(ordered[mid]!) < y) lo = mid + 1;
    else hi = mid;
  }
  if (lo === 0) return dst(first);
  const a = ordered[lo - 1]!;
  const b = ordered[lo]!;
  const span = src(b) - src(a);
  if (span <= 0) return dst(a);
  const ratio = (y - src(a)) / span;
  return dst(a) + ratio * (dst(b) - dst(a));
}

export function withinScrollExtent(value: number, scrollHeight: number, clientHeight: number): number {
  const maxScroll = Math.max(0, scrollHeight - clientHeight);
  return Math.max(0, Math.min(maxScroll, value));
}

export function positionAnchors(
  matches: readonly MatchAnchor[],
  lookupPosition: (side: Side, blockID: string) => number | null,
): ScrollAnchor[] {
  const seenPairs = new Set<string>();
  const raw: ScrollAnchor[] = [];
  for (const match of matches) {
    if (!match.leftBlockID || !match.rightBlockID) continue;
    const pairKey = `${match.leftBlockID}:${match.rightBlockID}`;
    if (seenPairs.has(pairKey)) continue;
    seenPairs.add(pairKey);
    const leftY = lookupPosition("left", match.leftBlockID);
    const rightY = lookupPosition("right", match.rightBlockID);
    if (leftY !== null && rightY !== null) {
      raw.push({ leftY, rightY });
    }
  }
  return monotoneAnchors(raw);
}
