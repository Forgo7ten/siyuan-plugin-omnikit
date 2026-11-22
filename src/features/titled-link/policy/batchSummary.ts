import type { LinkActionResult } from "./types.ts";

export type BatchSummary = {
  readonly total: number;
  readonly succeeded: number;
  readonly updated: number;
  readonly unchanged: number;
  readonly conflict: number;
  readonly failed: number;
  readonly imeTimeout: number;
  readonly unknown: number;
  readonly skipped: number;
  readonly superseded: number;
  readonly aborted: number;
};

/**
 * Aggregate per-link action outcomes into conserved terminal buckets:
 * `succeeded = updated + unchanged`, `skipped = superseded + aborted`,
 * and `succeeded + conflict + failed + imeTimeout + unknown + skipped === total`.
 */
export function countBatchResults(results: readonly LinkActionResult[]): BatchSummary {
  let updated = 0;
  let unchanged = 0;
  let conflict = 0;
  let failed = 0;
  let imeTimeout = 0;
  let unknown = 0;
  let superseded = 0;
  let aborted = 0;

  for (const result of results) {
    switch (result) {
      case "updated": updated += 1; break;
      case "unchanged": unchanged += 1; break;
      case "conflict": conflict += 1; break;
      case "failed": failed += 1; break;
      case "ime-timeout": imeTimeout += 1; break;
      case "unknown": unknown += 1; break;
      case "superseded": superseded += 1; break;
      case "aborted": aborted += 1; break;
    }
  }

  return {
    total: results.length,
    succeeded: updated + unchanged,
    updated,
    unchanged,
    conflict,
    failed,
    imeTimeout,
    unknown,
    skipped: superseded + aborted,
    superseded,
    aborted,
  };
}

/** Format batch summary with mandatory total and non-zero breakdown items only. */
export function formatBatchSummary(
  summary: BatchSummary,
  t: (key: string, values?: Record<string, string | number>) => string,
): string {
  const sep = t("titledLink.batchPart.sep");
  const parts: string[] = [t("titledLink.batchPart.total", { count: summary.total })];
  if (summary.succeeded > 0) {
    const sub: string[] = [];
    if (summary.updated > 0) sub.push(t("titledLink.batchPart.updated", { count: summary.updated }));
    if (summary.unchanged > 0) sub.push(t("titledLink.batchPart.unchanged", { count: summary.unchanged }));
    parts.push(t("titledLink.batchPart.succeeded", { count: summary.succeeded, detail: sub.join(sep) }));
  }
  if (summary.conflict > 0) parts.push(t("titledLink.batchPart.conflict", { count: summary.conflict }));
  if (summary.failed > 0) parts.push(t("titledLink.batchPart.failed", { count: summary.failed }));
  if (summary.imeTimeout > 0) parts.push(t("titledLink.batchPart.imeTimeout", { count: summary.imeTimeout }));
  if (summary.unknown > 0) parts.push(t("titledLink.batchPart.unknown", { count: summary.unknown }));
  if (summary.skipped > 0) parts.push(t("titledLink.batchPart.skipped", { count: summary.skipped }));
  return t("titledLink.batchSummary", { details: parts.join(sep) });
}
