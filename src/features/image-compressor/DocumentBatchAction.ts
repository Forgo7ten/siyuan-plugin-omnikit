import { showMessage } from "siyuan";
import type { FeatureContext } from "../../core/FeatureContext.ts";
import type { FeatureScope } from "../../core/FeatureScope.ts";
import { isMobileFrontend } from "../../core/Platform.ts";
import { translate } from "../../i18n/translate.ts";
import { recordRewrittenReference, type CompressionBatchSummary, type CompressionProgress } from "./CompressionResult.ts";
import { isDocumentRootIdentity } from "./DocumentIdentity.ts";
import { prepareImage, type ImageProcessingServices } from "./ImageProcessingServices.ts";
import type { ImageSource } from "./source.ts";
import type { ReferencePlan, ReferenceResult, DocumentRow } from "./references.ts";
import type { Mapping } from "./dom.ts";
import { scanDocumentImages, type DocumentImageOccurrence } from "./scanDocumentImages.ts";

export interface BatchActionOptions {
  signal?: AbortSignal;
  onProgress?: (progress: CompressionProgress) => void;
}

type Occurrence = DocumentImageOccurrence;
interface Prepared { source: ImageSource; path: string; originalBytes: number; compressedBytes: number; }

/** Prepares each source with bounded concurrency, then commits one shared reference plan. */
export async function compressDocumentImages(
  detail: any,
  context: FeatureContext,
  scope: FeatureScope,
  services: ImageProcessingServices,
  options: BatchActionOptions = {},
): Promise<CompressionBatchSummary> {
  const protyle = detail?.protyle ?? detail?.editor?.protyle;
  const rootID = protyle?.block?.rootID;
  const summary: CompressionBatchSummary = {
    scanComplete: false, scannedBlocks: 0, total: 0, completed: 0, succeeded: 0, skipped: 0, failed: 0,
    conflicts: 0, cancelled: false, originalBytes: 0, compressedBytes: 0, referencesRewritten: 0,
    originalReferencedBytes: 0, newReferencedBytes: 0, logicalReductionBytes: 0, diskReclaimedBytes: 0,
  };
  const report = (currentFile?: string) => options.onProgress?.({ ...summary, currentFile });
  const signal = combineSignals(scope.signal, options.signal);
  if (!rootID || protyle?.disabled || !scope.active || signal.aborted) {
    if (signal.aborted || !scope.active) summary.cancelled = true;
    showMessage(translate(context.plugin.i18n, "image.batch.invalidDocument"), 5000);
    return summary;
  }

  const config = services.config();
  const editorNotebook = typeof protyle?.notebookId === "string" ? protyle.notebookId : undefined;
  let notebook = editorNotebook ?? "";
  let occurrences: Occurrence[];
  try {
    const identity = await services.kernel.post<any>("/api/block/getBlockInfo", { id: rootID, ...(editorNotebook ? { notebook: editorNotebook } : {}) }, { signal });
    if (!isDocumentRootIdentity(identity.data, rootID)) throw new Error("Unable to verify document identity");
    if (editorNotebook && identity.data?.box && editorNotebook !== identity.data.box) throw new Error("Document notebook changed");
    notebook = editorNotebook || identity.data?.box || protyle?.block?.box || "";
    const response = await services.kernel.post<any>("/api/block/getBlockDOM", { id: rootID, ...(notebook ? { notebook } : {}) }, { signal });
    if (response.data?.id !== rootID || typeof response.data.dom !== "string" || !response.data.dom.trim()) throw new Error("Invalid document DOM");
    const scan = scanDocumentImages(response.data.dom, services.origin, config);
    occurrences = scan.occurrences;
    summary.scannedBlocks = scan.scannedBlocks;
    summary.scanComplete = true;
  } catch (error) {
    if (signal.aborted || !scope.active) return cancelledSummary(summary);
    context.logger.warn("扫描当前文档图片失败", error);
    showMessage(translate(context.plugin.i18n, "image.batch.scanFailed"), 5000);
    return summary;
  }

  summary.total = occurrences.length;
  report();
  if (!occurrences.length) {
    showMessage(translate(context.plugin.i18n, "image.batch.noImages"), 4000);
    return summary;
  }

  // One prepared resource per source key; only the bounded workers hold image bytes.
  const byKey = new Map<string, Occurrence[]>();
  for (const occurrence of occurrences) {
    const list = byKey.get(occurrence.source.key) ?? [];
    list.push(occurrence);
    byKey.set(occurrence.source.key, list);
  }
  const prepared = new Map<string, Prepared>();
  const states = new Map<string, "success" | "skipped" | "failed">();
  const entries = [...byKey.entries()];
  const concurrency = isMobileFrontend() ? config.compression.concurrencyMobile : config.compression.concurrencyDesktop;
  await runLimited(entries, concurrency, async ([key, references]) => {
    if (signal.aborted || !scope.active) return;
    const source = references[0].source;
    report(source.raw);
    try {
      if (source.kind === "file" && (!config.sources.desktopLocalFiles || services.mobile)) { states.set(key, "skipped"); return; }
      if (source.kind === "remote" && !["https:", "http:"].includes(new URL(source.url).protocol)) { states.set(key, "skipped"); return; }
      if (source.kind === "asset" && source.box) { states.set(key, "skipped"); return; }
      const result = await prepareImage(services, source, rootID, { kind: "document", rootID }, config, signal);
      if (!result) { states.set(key, "skipped"); return; }
      prepared.set(key, { source, path: result.path, originalBytes: result.originalBytes, compressedBytes: result.compressedBytes });
      states.set(key, "success");
    } catch (error) {
      if (signal.aborted) return;
      states.set(key, "failed");
      context.logger.warn(`准备图片资源失败：${source.raw}`, error);
    }
  }, signal);
  if (signal.aborted || !scope.active) return cancelledSummary(summary);

  for (const [key, references] of byKey) {
    const state = states.get(key);
    const result = prepared.get(key);
    if (result) {
      summary.originalBytes += result.originalBytes;
      summary.compressedBytes += result.compressedBytes;
    }
    for (const occurrence of references) {
      if (state === "skipped") summary.skipped++;
      else if (state === "failed" || !state) summary.failed++;
      else continue;
      summary.completed++;
      report(occurrence.source.raw);
    }
  }

  const mappings: Mapping[] = [];
  summary.uploaded = prepared.size;
  for (const [key, result] of prepared) {
    mappings.push({ key, oldPath: referencePath(result.source), newPath: result.path });
  }
  if (!mappings.length) {
    if (signal.aborted || !scope.active) return cancelledSummary(summary);
    showComplete(context, summary);
    report();
    return summary;
  }

  const seed: DocumentRow = { id: rootID, root_id: rootID, box: notebook };
  let plan: ReferencePlan;
  try {
    const forceSQL = config.references.backend === "sql" || mappings.some(m => m.key.includes("?box="));
    plan = await services.references.plan(mappings, seed, config.references.maxDocuments,
      forceSQL, undefined, signal);
  } catch (error) {
    if (signal.aborted || !scope.active) return cancelledSummary(summary);
    context.logger.warn("生成图片引用计划失败", error);
    for (const [key, references] of byKey) if (prepared.has(key)) {
      for (const occurrence of references) { summary.failed++; summary.completed++; report(occurrence.source.raw); }
    }
    showComplete(context, summary);
    report();
    return summary;
  }
  if (signal.aborted || !scope.active) return cancelledSummary(summary);

  const affectedRoots = plan.rootIDs;
  const crossDocumentCount = affectedRoots.filter(id => id !== rootID).length;
  const message = translate(context.plugin.i18n, "image.confirmBatchReferences", {
    total: affectedRoots.length, external: crossDocumentCount,
  });
  if (!await services.ui.confirm(translate(context.plugin.i18n, "image.confirmBatchTitle"), message, signal)) {
    if (signal.aborted || !scope.active) return cancelledSummary(summary);
    summary.cancelled = true;
    return summary;
  }
  if (signal.aborted || !scope.active) return cancelledSummary(summary);

  let commit: ReferenceResult;
  try {
    commit = await services.references.commit(plan, signal);
  } catch (error) {
    if (signal.aborted || !scope.active) return cancelledSummary(summary);
    context.logger.warn("提交图片引用计划失败", error);
    commit = { backend: plan.backend, state: "unknown", referencesChanged: null, storageRecordsChanged: null,
      verifiedBlocks: [], conflictBlocks: [], cleanupEligible: false, reason: String(error) };
  }
  if (signal.aborted || !scope.active) return cancelledSummary(summary);

  summary.referenceResult = {
    backend: commit.backend,
    state: commit.state,
    referencesChanged: commit.referencesChanged,
    storageRecordsChanged: commit.storageRecordsChanged,
  };

  const verifiedBlocks = new Set(commit.verifiedBlocks);
  const conflictBlocks = new Set(commit.conflictBlocks);
  const countedPaths = new Set<string>();
  for (const [key, references] of byKey) {
    const resource = prepared.get(key);
    if (!resource) continue;
    for (const occurrence of references) {
      const verified = commit.state === "verified" && (plan.backend === "native" || verifiedBlocks.has(occurrence.blockId))
        || plan.backend === "sql" && verifiedBlocks.has(occurrence.blockId);
      if (verified) {
        recordRewrittenReference(summary, resource.source.raw, resource.originalBytes, resource.compressedBytes, countedPaths);
      } else if (conflictBlocks.has(occurrence.blockId) || commit.state === "partial" || commit.state === "unknown") {
        summary.conflicts++;
      } else {
        summary.failed++;
      }
      summary.completed++;
      report(occurrence.source.raw);
    }
  }
  showComplete(context, summary);
  report();
  return summary;
}

function referencePath(source: ImageSource): string {
  return source.kind === "asset" ? source.path + (source.box ? `?box=${source.box}` : "")
    : source.kind === "remote" ? source.url : source.fileURL;
}

async function runLimited<T>(items: T[], limit: number, worker: (item: T) => Promise<void>, signal: AbortSignal): Promise<void> {
  let cursor = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (!signal.aborted && cursor < items.length) await worker(items[cursor++]);
  }));
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
function showComplete(context: FeatureContext, summary: CompressionBatchSummary): void {
  showMessage(translate(context.plugin.i18n, "image.batch.complete", {
    succeeded: summary.succeeded, skipped: summary.skipped, failed: summary.failed, conflicts: summary.conflicts,
    logical: formatBytes(summary.logicalReductionBytes), reclaimed: formatBytes(summary.diskReclaimedBytes),
  }), 7000);
}
function formatBytes(size: number): string { return size < 1024 ? `${size} B` : `${(size / 1024).toFixed(1)} KB`; }
