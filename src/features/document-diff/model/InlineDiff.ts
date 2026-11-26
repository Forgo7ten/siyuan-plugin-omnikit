import type { TextSpan } from "./types.ts";

export interface InlineDiffPair {
  leftRanges: TextSpan[];
  rightRanges: TextSpan[];
}

interface CodePointToken {
  value: string;
  utf16Offset: number;
  utf16Length: number;
}

function tokenizeCodePoints(text: string): CodePointToken[] {
  const out: CodePointToken[] = [];
  let offset = 0;
  for (const ch of text) {
    const len = ch.length;
    out.push({ value: ch, utf16Offset: offset, utf16Length: len });
    offset += len;
  }
  return out;
}

function mergeContiguousRanges(tokens: readonly CodePointToken[], changedFlags: readonly boolean[]): TextSpan[] {
  const spans: TextSpan[] = [];
  let i = 0;
  while (i < tokens.length) {
    if (!changedFlags[i]) {
      i++;
      continue;
    }
    const start = tokens[i]!.utf16Offset;
    let end = start + tokens[i]!.utf16Length;
    i++;
    while (i < tokens.length && changedFlags[i]) {
      end = tokens[i]!.utf16Offset + tokens[i]!.utf16Length;
      i++;
    }
    if (end > start) {
      spans.push({ start, end });
    }
  }
  return spans;
}

/**
 * Character-level budgeted LCS aligned with SiYuan's `markDocInlineDiffWithBudget`.
 * Preserves surrogate pairs and returns UTF-16 offsets suitable for DOM Range endpoints.
 */
export function computeInlineDiffRanges(
  leftText: string,
  rightText: string,
  maxCells = 200_000,
): InlineDiffPair {
  if (leftText === rightText) {
    return { leftRanges: [], rightRanges: [] };
  }
  const leftTokens = tokenizeCodePoints(leftText);
  const rightTokens = tokenizeCodePoints(rightText);
  if (leftTokens.length === 0) {
    return {
      leftRanges: [],
      rightRanges: rightText.length > 0 ? [{ start: 0, end: rightText.length }] : [],
    };
  }
  if (rightTokens.length === 0) {
    return {
      leftRanges: leftText.length > 0 ? [{ start: 0, end: leftText.length }] : [],
      rightRanges: [],
    };
  }

  let prefix = 0;
  while (
    prefix < leftTokens.length &&
    prefix < rightTokens.length &&
    leftTokens[prefix]!.value === rightTokens[prefix]!.value
  ) {
    prefix++;
  }

  let suffix = 0;
  while (
    prefix + suffix < leftTokens.length &&
    prefix + suffix < rightTokens.length &&
    leftTokens[leftTokens.length - 1 - suffix]!.value === rightTokens[rightTokens.length - 1 - suffix]!.value
  ) {
    suffix++;
  }

  const leftMidLen = leftTokens.length - prefix - suffix;
  const rightMidLen = rightTokens.length - prefix - suffix;
  if (leftMidLen === 0 && rightMidLen === 0) {
    return { leftRanges: [], rightRanges: [] };
  }

  const cells = (leftMidLen + 1) * (rightMidLen + 1);
  if (cells > maxCells) {
    const leftRanges: TextSpan[] = leftMidLen > 0
      ? [{
          start: leftTokens[prefix]!.utf16Offset,
          end: leftTokens[prefix + leftMidLen - 1]!.utf16Offset + leftTokens[prefix + leftMidLen - 1]!.utf16Length,
        }]
      : [];
    const rightRanges: TextSpan[] = rightMidLen > 0
      ? [{
          start: rightTokens[prefix]!.utf16Offset,
          end: rightTokens[prefix + rightMidLen - 1]!.utf16Offset + rightTokens[prefix + rightMidLen - 1]!.utf16Length,
        }]
      : [];
    return { leftRanges, rightRanges };
  }

  const leftChanged = new Array<boolean>(leftTokens.length).fill(false);
  const rightChanged = new Array<boolean>(rightTokens.length).fill(false);
  for (let i = prefix; i < prefix + leftMidLen; i++) leftChanged[i] = true;
  for (let j = prefix; j < prefix + rightMidLen; j++) rightChanged[j] = true;

  if (leftMidLen > 0 && rightMidLen > 0) {
    const width = rightMidLen + 1;
    const dp = new Uint32Array(cells);
    for (let i = leftMidLen - 1; i >= 0; i--) {
      for (let j = rightMidLen - 1; j >= 0; j--) {
        const idx = i * width + j;
        if (leftTokens[prefix + i]!.value === rightTokens[prefix + j]!.value) {
          dp[idx] = dp[(i + 1) * width + j + 1]! + 1;
        } else {
          const down = dp[(i + 1) * width + j]!;
          const right = dp[i * width + j + 1]!;
          dp[idx] = down >= right ? down : right;
        }
      }
    }
    let i = 0;
    let j = 0;
    while (i < leftMidLen && j < rightMidLen) {
      if (leftTokens[prefix + i]!.value === rightTokens[prefix + j]!.value) {
        leftChanged[prefix + i] = false;
        rightChanged[prefix + j] = false;
        i++;
        j++;
      } else if (dp[(i + 1) * width + j]! >= dp[i * width + j + 1]!) {
        i++;
      } else {
        j++;
      }
    }
  }

  return {
    leftRanges: mergeContiguousRanges(leftTokens, leftChanged),
    rightRanges: mergeContiguousRanges(rightTokens, rightChanged),
  };
}

/**
 * Resolves verified UTF-16 ranges inside a block's concatenated editable text.
 * Returns null if the live block text cannot be proven to match `expectedLines`
 * (preventing mis-highlighting repeated occurrences).
 */
export function verifiedLineSpans(
  visibleText: string,
  expectedLines: readonly string[],
  line: number,
  localSpans?: readonly TextSpan[],
): TextSpan[] | null {
  if (line < 0 || !Number.isInteger(line) || line >= expectedLines.length) {
    return null;
  }
  const lineText = expectedLines[line]!;
  const joinedExpected = expectedLines.join("\n");
  let lineStart = -1;
  if (visibleText === joinedExpected || visibleText === `${joinedExpected}\n`) {
    let offset = 0;
    for (let i = 0; i < line; i++) {
      offset += expectedLines[i]!.length + 1;
    }
    lineStart = offset;
  } else if (expectedLines.length === 1 && lineText.length > 0) {
    const first = visibleText.indexOf(lineText);
    if (first >= 0 && first === visibleText.lastIndexOf(lineText)) {
      lineStart = first;
    }
  }
  if (lineStart < 0) return null;

  if (!localSpans) {
    if (lineText.length === 0) return null;
    return [{ start: lineStart, end: lineStart + lineText.length }];
  }
  const out: TextSpan[] = [];
  for (const span of localSpans) {
    const start = Math.max(0, Math.min(lineText.length, span.start));
    const end = Math.max(start, Math.min(lineText.length, span.end));
    if (end > start) {
      out.push({ start: lineStart + start, end: lineStart + end });
    }
  }
  return out.length > 0 ? out : null;
}
