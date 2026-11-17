import { showMessage } from "siyuan";
import type { FeatureContext } from "../../../core/framework/FeatureContext.ts";
import type { FeatureScope } from "../../../core/framework/FeatureScope.ts";
import { translate } from "../../../i18n/translate.ts";
import { combineSignals, resolveEditorRootID } from "../../../core/host/ProtyleAdapter.ts";
import { recordRewrittenReference, type CompressionBatchSummary, type CompressionProgress } from "../policy/CompressionResult.ts";
import { isDocumentRootIdentity } from "../policy/DocumentIdentity.ts";
import type { ImageProcessingServices } from "../services/ImageProcessingServices.ts";
import { resolveSource, type ImageSource } from "../policy/source.ts";
import type { OccurrenceTarget } from "../policy/contracts.ts";
import { resolveImageOccurrence } from "../services/ImageOccurrenceResolver.ts";
import { sqlLiteral } from "../services/references.ts";
import { scanDocumentImages, type DocumentImageOccurrence } from "./scanDocumentImages.ts";

export interface BatchActionOptions {
  signal?: AbortSignal;
  onProgress?: (progress: CompressionProgress) => void;
}

interface AuthorizedOccurrence { target: OccurrenceTarget; source: ImageSource }
interface Prepared {
  path: string;
  originalBytes: number;
  compressedBytes: number;
  quality?: number;
  similarity?: number;
}

/**
 * Compresses one document's assets with bounded concurrency in preparation,
 * then commits captured occurrences strictly sequentially with transactional verification.
 */
export async function compressDocumentImages(
  detail: any,
  context: FeatureContext,
  scope: FeatureScope,
  services: ImageProcessingServices,
  options: BatchActionOptions = {},
): Promise<CompressionBatchSummary> {
  const protyle = detail?.protyle ?? detail?.editor?.protyle;
  const rootID = resolveEditorRootID(detail);
  const summary: CompressionBatchSummary = {
    scanComplete: false, scannedBlocks: 0, total: 0, completed: 0, succeeded: 0, skipped: 0, failed: 0,
    conflicts: 0, cancelled: false, originalBytes: 0, compressedBytes: 0, referencesRewritten: 0,
    originalReferencedBytes: 0, newReferencedBytes: 0, logicalReductionBytes: 0, diskReclaimedBytes: 0,
  };
  const report = (currentFile?: string) => options.onProgress?.({ ...summary, currentFile });
  const signal = combineSignals(scope.signal, options.signal) ?? scope.signal;
  if (signal.aborted || !scope.active) {
    return cancelledSummary(summary);
  }
  if (!rootID || protyle?.disabled) {
    showMessage(translate(context.plugin.i18n, "image.batch.invalidDocument"), 5000);
    return summary;
  }

  const config = services.config();
  const editorNotebook = typeof protyle?.notebookId === "string" ? protyle.notebookId : undefined;
  let notebook = editorNotebook ?? "";
  try {
    const identity = await services.kernel.post<any>("/api/block/getBlockInfo", { id: rootID, ...(editorNotebook ? { notebook: editorNotebook } : {}) }, { signal });
    if (!isDocumentRootIdentity(identity.data, rootID)) throw new Error("Unable to verify document identity");
    if (editorNotebook && identity.data?.box && editorNotebook !== identity.data.box) throw new Error("Document notebook changed");
    notebook = editorNotebook || identity.data?.box || protyle?.block?.box || "";
    if (!notebook) throw new Error("Document notebook is unavailable");
  } catch (error) {
    if (signal.aborted || !scope.active) return cancelledSummary(summary);
    context.logger.warn("验证当前文档身份失败", error);
    return summary;
  }

  const targetNotebook = notebook;
  const blockDOMs = new Map<string, string>();
  const scanned: DocumentImageOccurrence[] = [];
  try {
    const stmt = `SELECT id, markdown FROM blocks WHERE root_id = ${sqlLiteral(rootID)} AND type = 'p' AND markdown LIKE '%assets/%'`;
    const sqlRes = await services.kernel.post<Array<{ id: string; markdown?: string }>>(
      "/api/query/sql",
      { stmt, mode: "readonly" },
      { signal },
    );
    const rows = Array.isArray(sqlRes.data) ? sqlRes.data : [];
    summary.scannedBlocks = rows.length;
    for (const row of rows) {
      if (signal.aborted || !scope.active) return cancelledSummary(summary);
      if (!row?.id) continue;
      try {
        const response = await services.kernel.post<any>("/api/block/getBlockDOM", { id: row.id, notebook: targetNotebook }, { signal });
        if (response.data?.id === row.id && typeof response.data.dom === "string" && response.data.dom.trim()) {
          blockDOMs.set(row.id, response.data.dom);
          const scan = scanDocumentImages(response.data.dom, services.origin, config);
          scanned.push(...scan.occurrences);
        }
      } catch (error) {
        context.logger.warn(`读取图片块失败：${row.id}`, error);
      }
    }
    summary.scanComplete = true;
  } catch (error) {
    if (signal.aborted || !scope.active) return cancelledSummary(summary);
    context.logger.warn("扫描当前文档图片失败", error);
    return summary;
  }

  const authorized: AuthorizedOccurrence[] = [];
  for (const occurrence of scanned) {
    if (signal.aborted || !scope.active) return cancelledSummary(summary);
    const dom = blockDOMs.get(occurrence.blockId);
    if (!dom) {
      summary.failed++;
      summary.completed++;
      continue;
    }
    const target = resolveImageOccurrence(dom, {
      rootID, notebook: targetNotebook, blockID: occurrence.blockId, imageOrdinal: occurrence.imageOrdinal, oldPath: occurrence.source.raw,
    });
    if (!target) {
      summary.conflicts++;
      summary.completed++;
      continue;
    }
    authorized.push({ target, source: occurrence.source });
  }
  summary.total = scanned.length;
  report();
  if (!scanned.length) {
    return summary;
  }

  const byKey = new Map<string, AuthorizedOccurrence[]>();
  for (const item of authorized) {
    const group = byKey.get(item.source.key) ?? [];
    group.push(item);
    byKey.set(item.source.key, group);
  }

  const countedPaths = new Set<string>();
  const distinctGroups = [...byKey.entries()];
  const preparedMap = new Map<string, Prepared>();
  const failedKeys = new Set<string>();
  let uploaded = 0;

  // Preparation phase with bounded concurrency: desktop 2, mobile 1
  const concurrency = services.mobile ? 1 : Math.max(1, config.compression.concurrencyDesktop ?? 2);
  let nextIdx = 0;

  async function prepareWorker(): Promise<void> {
    while (nextIdx < distinctGroups.length) {
      if (signal.aborted || !scope.active) return;
      const idx = nextIdx++;
      const [key, locations] = distinctGroups[idx];
      const source = locations[0].source;
      report(source.raw);

      if (source.kind !== "asset" || source.box) {
        continue;
      }

      try {
        const result = await services.compressOccurrence(locations[0].target, config, signal, {
          replace: false,
          mode: "document",
        });
        if (result.status === "saved") {
          const origBytes = result.originalBytes ?? 0;
          const compBytes = result.compressedBytes ?? 0;
          preparedMap.set(key, {
            path: result.path,
            originalBytes: origBytes,
            compressedBytes: compBytes,
            quality: result.quality,
            similarity: result.similarity,
          });
          uploaded++;
          summary.originalBytes += origBytes;
          summary.compressedBytes += compBytes;
        }
      } catch (error) {
        if (signal.aborted || !scope.active) return;
        context.logger.warn(`准备图片资源失败：${source.raw}`, error);
        failedKeys.add(key);
      }
    }
  }

  const workers = Array.from({ length: Math.min(concurrency, distinctGroups.length) }, () => prepareWorker());
  await Promise.all(workers);
  if (signal.aborted || !scope.active) return cancelledSummary(summary);

  // Sequential occurrence replacement phase
  for (const [key, locations] of distinctGroups) {
    if (signal.aborted || !scope.active) return cancelledSummary(summary);
    const source = locations[0].source;
    report(source.raw);

    if (source.kind !== "asset" || source.box) {
      for (const _item of locations) { summary.skipped++; summary.completed++; }
      continue;
    }

    if (failedKeys.has(key)) {
      for (const _item of locations) { summary.failed++; summary.completed++; }
      continue;
    }

    const prepared = preparedMap.get(key);
    if (!prepared) {
      for (const _item of locations) { summary.skipped++; summary.completed++; }
      continue;
    }

    let anyReplaced = false;
    for (const item of locations) {
      if (signal.aborted || !scope.active) return cancelledSummary(summary);
      const target = item.target;
      try {
        const committed = await services.references.commitOccurrence(target, prepared.path, signal);
        if (committed === "replaced") {
          anyReplaced = true;
          recordRewrittenReference(summary, source.raw, prepared.originalBytes, prepared.compressedBytes, countedPaths);
        } else if (committed === "conflict") {
          summary.conflicts++;
        } else {
          summary.failed++;
        }
      } catch (error) {
        context.logger.warn(`提交图片引用失败：${source.raw}`, error);
        summary.failed++;
      }
      summary.completed++;
      report(source.raw);
    }
    await services.records.markOperation(source.path, prepared.path, anyReplaced ? "replaced" : "incomplete").catch(() => undefined);
  }

  summary.uploaded = uploaded;
  report();
  return summary;
}

function cancelledSummary(summary: CompressionBatchSummary): CompressionBatchSummary { summary.cancelled = true; return summary; }
