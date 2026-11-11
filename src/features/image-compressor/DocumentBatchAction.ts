import { showMessage } from "siyuan";
import type { FeatureContext } from "../../core/FeatureContext.ts";
import type { FeatureScope } from "../../core/FeatureScope.ts";
import { isMobileFrontend } from "../../core/Platform.ts";
import { AssetRepository } from "./AssetRepository.ts";
import { calculateSHA256, groupByContentHash, runLimited } from "./CompressionQueue.ts";
import { ImageCompressorService } from "./ImageCompressorService.ts";
import { rewriteImageBlockOnce } from "./BlockImageRewriter.ts";
import { isEligibleImage } from "./ImageEligibility.ts";
import type { ImageSettings } from "./settings.ts";
import type { CompressionBatchSummary, CompressionItemResult, CompressionProgress } from "./CompressionResult.ts";
import { translate } from "../../i18n/translate.ts";

export interface BatchActionOptions {
  signal?: AbortSignal;
  onProgress?: (progress: CompressionProgress) => void;
}

interface ImageOccurrence { image: HTMLImageElement; blockId: string; source: string; }
interface PathWork { path: string; occurrences: ImageOccurrence[]; blob?: Blob; error?: unknown; groupKey?: string; }
type Result = CompressionItemResult;

/** @safety Works only on the active editor root. Re-reads each affected block and updates it at most once. */
export async function compressDocumentImages(detail: any, context: FeatureContext, scope: FeatureScope, settings: ImageSettings, service: ImageCompressorService, options: BatchActionOptions = {}): Promise<CompressionBatchSummary> {
  const protyle = detail?.protyle ?? detail?.editor?.protyle;
  const rootId = protyle?.block?.rootID;
  const root = protyle?.element as HTMLElement | undefined;
  const summary: CompressionBatchSummary = { total: 0, completed: 0, succeeded: 0, skipped: 0, failed: 0, conflicts: 0, cancelled: false, originalBytes: 0, compressedBytes: 0, savedBytes: 0 };
  const report = (currentFile?: string) => options.onProgress?.({ ...summary, currentFile });
  const signal = combineSignals(scope.signal, options.signal);
  if (!rootId || !root || protyle?.disabled || !scope.active || signal.aborted) {
    if (signal.aborted || !scope.active) summary.cancelled = true;
    showMessage(translate(context.plugin.i18n, "image.batch.invalidDocument"), 5000); return summary;
  }

  const occurrences: ImageOccurrence[] = Array.from(root.querySelectorAll("img")).flatMap(image => {
    const blockId = image.closest("[data-node-id]")?.getAttribute("data-node-id");
    const source = image.getAttribute("data-src") || image.getAttribute("src");
    return blockId && source && isLocalAsset(source) && isEligibleImage(source) ? [{ image, blockId, source }] : [];
  });
  summary.total = occurrences.length;
  report();
  if (!occurrences.length) { showMessage(translate(context.plugin.i18n, "image.batch.noImages"), 4000); return summary; }
  if (occurrences.length > 1000) { showMessage(translate(context.plugin.i18n, "image.batch.tooMany"), 5000); return summary; }

  const byPath = new Map<string, PathWork>();
  for (const occurrence of occurrences) {
    const work = byPath.get(occurrence.source) ?? { path: occurrence.source, occurrences: [] };
    work.occurrences.push(occurrence); byPath.set(occurrence.source, work);
  }
  const concurrency = isMobileFrontend() ? (settings.concurrencyMobile ?? 1) : (settings.concurrencyDesktop ?? 2);
  const repository = new AssetRepository();
  const works = [...byPath.values()];
  await runLimited(works, Math.max(1, concurrency), async work => {
    if (signal.aborted) return;
    try {
      report(work.path);
      const response = await fetch(work.occurrences[0].image.currentSrc || work.path, { signal });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      work.blob = await response.blob();
      work.groupKey = await calculateSHA256(work.blob) ?? `path:${work.path}`;
    } catch (error) { work.error = error; }
  }, signal);
  if (signal.aborted || !scope.active) return cancelledSummary(summary);

  const groups = groupByContentHash(works);
  const resultByPath = new Map<string, Result>();
  const contentResults = new Map<string, Result>();
  const uniqueGroups = [...groups.entries()];
  await runLimited(uniqueGroups, Math.max(1, concurrency), async ([key, group]) => {
    if (signal.aborted) return;
    const representative = group[0];
    try {
      report(representative.path);
      const compressed = await service.compress(representative.blob!, representative.path, settings, signal);
      if (!compressed) {
        const result: Result = { path: representative.path, state: "skipped", originalBytes: representative.blob!.size, compressedBytes: representative.blob!.size };
        contentResults.set(key, result); return;
      }
      if (signal.aborted) return;
      const next = await repository.upload(compressed.blob, rootId, representative.path, signal);
      contentResults.set(key, { path: representative.path, next, state: "success", originalBytes: compressed.originalBytes, compressedBytes: compressed.compressedBytes });
    } catch (error) {
      if (signal.aborted) return;
      context.logger.warn(`准备图片资源失败：${representative.path}`, error);
      contentResults.set(key, { path: representative.path, state: "failed", originalBytes: representative.blob!.size, compressedBytes: 0 });
    }
  }, signal);
  if (signal.aborted || !scope.active) return cancelledSummary(summary);
  for (const work of works) {
    if (work.error || !work.blob) resultByPath.set(work.path, { path: work.path, state: "failed", originalBytes: 0, compressedBytes: 0 });
    else {
      const contentResult = contentResults.get(work.groupKey!)!;
      resultByPath.set(work.path, { ...contentResult, path: work.path });
    }
  }
  for (const work of works) {
    const result = resultByPath.get(work.path);
    if (!result) continue;
    summary.originalBytes += result.originalBytes;
    summary.compressedBytes += result.compressedBytes;
  }

  const completedOccurrences = new Set<ImageOccurrence>();
  const savedPaths = new Set<string>();
  for (const occurrence of occurrences) {
    const result = resultByPath.get(occurrence.source);
    if (result?.state === "failed") summary.failed++;
    else if (result?.state === "skipped") summary.skipped++;
    else continue;
    completedOccurrences.add(occurrence);
    summary.completed++;
    report(occurrence.source);
  }

  const eligibleWorks = works.filter(work => resultByPath.get(work.path)?.state === "success");
  const blockGroups = new Map<string, ImageOccurrence[]>();
  for (const work of eligibleWorks) for (const occurrence of work.occurrences) {
    const list = blockGroups.get(occurrence.blockId) ?? []; list.push(occurrence); blockGroups.set(occurrence.blockId, list);
  }
  const updatedOccurrences = new Set<ImageOccurrence>();
  const conflictedOccurrences = new Set<ImageOccurrence>();
  for (const [blockId, blockOccurrences] of blockGroups) {
    if (signal.aborted || !scope.active) break;
    const paths = [...new Set(blockOccurrences.map(item => item.source))];
    const replacements = new Map(paths.map(path => [path, {
      nextURL: resultByPath.get(path)!.next!,
      expectedCount: blockOccurrences.filter(item => item.source === path).length,
    }]));
    try {
      const result = await rewriteImageBlockOnce(repository, blockId, replacements, signal);
      if (result === "cancelled" || !scope.active) break;
      if (result === "conflict") { for (const item of blockOccurrences) conflictedOccurrences.add(item); continue; }
      for (const item of blockOccurrences) {
        const result = resultByPath.get(item.source)!;
        updatedOccurrences.add(item);
        completedOccurrences.add(item);
        summary.succeeded++;
        summary.completed++;
        if (!savedPaths.has(item.source)) {
          savedPaths.add(item.source);
          summary.savedBytes += Math.max(0, result.originalBytes - result.compressedBytes);
        }
        if ((item.image.getAttribute("data-src") || item.image.getAttribute("src")) === item.source) {
          item.image.setAttribute("src", result.next!); item.image.setAttribute("data-src", result.next!);
        }
        report(item.source);
      }
    } catch (error) { for (const item of blockOccurrences) conflictedOccurrences.add(item); context.logger.warn(`更新图片块失败：${blockId}`, error); }
  }

  for (const occurrence of occurrences) {
    const result = resultByPath.get(occurrence.source);
    if (signal.aborted || !scope.active) break;
    if (completedOccurrences.has(occurrence)) continue;
    if (result?.state === "success" || conflictedOccurrences.has(occurrence)) summary.conflicts++;
    else summary.failed++;
    completedOccurrences.add(occurrence);
    summary.completed++;
    report(occurrence.source);
  }
  if (signal.aborted || !scope.active) return cancelledSummary(summary);
  showMessage(translate(context.plugin.i18n, "image.batch.complete", {
    succeeded: summary.succeeded,
    skipped: summary.skipped,
    failed: summary.failed,
    conflicts: summary.conflicts,
    saved: formatBytes(summary.savedBytes),
  }), 7000);
  report();
  return summary;
}

function combineSignals(...signals: Array<AbortSignal | undefined>): AbortSignal {
  const controller = new AbortController();
  for (const signal of signals) {
    if (!signal) continue;
    if (signal.aborted) controller.abort(signal.reason);
    else signal.addEventListener("abort", () => controller.abort(signal.reason), { once: true });
  }
  return controller.signal;
}
function cancelledSummary(summary: CompressionBatchSummary): CompressionBatchSummary { summary.cancelled = true; return summary; }
function isLocalAsset(path: string): boolean { return /^assets\//i.test(path) && !/[?#]/.test(path) && !/excalidraw/i.test(path); }
function formatBytes(size: number): string { return size < 1024 ? `${size} B` : `${(size / 1024).toFixed(1)} KB`; }
