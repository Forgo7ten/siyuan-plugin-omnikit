import { isAbortError } from "../../../core/feedback/UiFeedback.ts";
import type { FeatureContext } from "../../../core/framework/FeatureContext.ts";
import type { FeatureScope } from "../../../core/framework/FeatureScope.ts";
import {
  combineSignals,
  flushProtyleTransactions,
  listEditorsSafe,
  resolveEditorRootID,
  resolveNotebookID,
} from "../../../core/host/ProtyleAdapter.ts";
import { recordRewrittenReference, type CompressionBatchSummary, type CompressionProgress } from "../policy/CompressionResult.ts";
import { isDocumentRootIdentity } from "../policy/DocumentIdentity.ts";
import { localizeRemoteAsset, logReferenceStatus, type ImageProcessingServices } from "../services/ImageProcessingServices.ts";
import { recaptureReplacedImageOccurrence } from "../services/ImageOccurrenceResolver.ts";
import { resolveSource, type ImageSource } from "../policy/source.ts";
import type { OccurrenceTarget } from "../policy/contracts.ts";
import { scanDocumentImages, type DocumentImageOccurrence } from "./scanDocumentImages.ts";

export interface BatchActionOptions {
  signal?: AbortSignal;
  onProgress?: (progress: CompressionProgress) => void;
  rootID?: string;
  notebook?: string;
  getAllEditor?: () => unknown[];
}

interface FlushableEditor {
  disabled?: boolean;
  destroyed?: boolean;
  block?: { rootID?: string };
  protyle?: {
    disabled?: boolean;
    destroyed?: boolean;
    block?: { rootID?: string };
  };
  getInstance?: () => FlushableEditor;
  flushPendingTransactions?: () => Promise<void>;
}

async function loadGetAllEditor(): Promise<(() => unknown[]) | undefined> {
  try {
    const siyuan = await import("siyuan");
    return typeof siyuan.getAllEditor === "function" ? siyuan.getAllEditor : undefined;
  } catch {
    return undefined;
  }
}

async function flushMatchingEditors(
  targetRootID: string,
  detailProtyle: FlushableEditor | undefined,
  context: FeatureContext,
  options: BatchActionOptions,
  signal: AbortSignal,
  scope: FeatureScope,
): Promise<boolean> {
  const candidates: Array<{ editor: unknown; requireRootMatch: boolean }> = [];
  if (detailProtyle) {
    candidates.push({ editor: detailProtyle, requireRootMatch: false });
  }
  const getAllEditor = options.getAllEditor ?? await loadGetAllEditor();
  if (signal.aborted || !scope.active) return false;
  for (const editor of listEditorsSafe(getAllEditor, context.logger)) {
    candidates.push({ editor, requireRootMatch: true });
  }

  const flushed = new Set<object>();
  for (const { editor, requireRootMatch } of candidates) {
    if (!editor || typeof editor !== "object") continue;
    const item = editor as FlushableEditor;
    const runner = typeof item.getInstance === "function" ? item.getInstance() : item;
    if (!runner || typeof runner !== "object" || flushed.has(runner)) continue;
    const meta = runner.protyle ?? item.protyle ?? runner;
    const editorRootID = resolveEditorRootID(runner) ?? resolveEditorRootID(item);
    if (requireRootMatch ? editorRootID !== targetRootID : (editorRootID !== undefined && editorRootID !== targetRootID)) {
      continue;
    }
    if (item.disabled || runner.disabled || meta?.disabled || item.destroyed || runner.destroyed || meta?.destroyed) {
      continue;
    }
    flushed.add(runner);
    await flushProtyleTransactions(item);
    if (signal.aborted || !scope.active) return false;
  }
  return true;
}

interface AuthorizedOccurrence { target: OccurrenceTarget; source: ImageSource }
interface Prepared {
  path: string;
  originalBytes: number;
  compressedBytes: number;
  quality?: number;
  similarity?: number;
}
interface PreparedRemote {
  localPath: string;
  localSource: Extract<ImageSource, { kind: "asset" }>;
  file: File;
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
  const protyle = detail?.protyle;
  const rootID = options.rootID ?? resolveEditorRootID(detail);
  const summary: CompressionBatchSummary = {
    scanComplete: false, scannedBlocks: 0, total: 0, completed: 0, succeeded: 0, skipped: 0, failed: 0,
    conflicts: 0, unknown: 0, cancelled: false, originalBytes: 0, compressedBytes: 0, referencesRewritten: 0,
    originalReferencedBytes: 0, newReferencedBytes: 0, logicalReductionBytes: 0,
  };
  let uploaded = 0;
  let phase: "preparing" | "applying" = "preparing";
  let prepared = 0;
  let preparedTotal = 0;
  const report = (currentFile?: string) => options.onProgress?.({
    ...summary,
    currentFile,
    phase,
    uploaded,
    ...(preparedTotal > 0 ? { prepared, preparedTotal } : {}),
  });

  const signal = combineSignals(scope.signal, options.signal) ?? scope.signal;
  if (signal.aborted || !scope.active) {
    return cancelledSummary(summary);
  }
  if (!rootID || protyle?.disabled) {
    return summary;
  }
  const verifiedRootID: string = rootID;

  const config = services.config();
  const editorNotebook = options.notebook ?? resolveNotebookID(detail);
  let notebook = editorNotebook ?? "";
  try {
    const identity = await services.kernel.post<any>("/api/block/getBlockInfo", { id: rootID, ...(editorNotebook ? { notebook: editorNotebook } : {}) }, { signal });
    if (!isDocumentRootIdentity(identity.data, rootID)) throw new Error("Unable to verify document identity");
    if (editorNotebook && identity.data?.box && editorNotebook !== identity.data.box) throw new Error("Document notebook changed");
    notebook = editorNotebook || identity.data?.box || "";
    if (!notebook) throw new Error("Document notebook is unavailable");
  } catch (error) {
    if (signal.aborted || !scope.active) return cancelledSummary(summary);
    context.logger.warn("验证当前文档身份失败", error);
    return summary;
  }

  const targetNotebook = notebook;
  let nestedBlockIds = new Set<string>();
  const scanned: DocumentImageOccurrence[] = [];
  try {
    const flushed = await flushMatchingEditors(verifiedRootID, protyle, context, options, signal, scope);
    if (!flushed) return cancelledSummary(summary);
    const domRes = await services.kernel.post<any>("/api/block/getBlockDOM", { id: rootID, notebook: targetNotebook }, { signal });
    if (signal.aborted || !scope.active) return cancelledSummary(summary);
    if (domRes.data?.id !== rootID || typeof domRes.data?.dom !== "string" || !domRes.data.dom.trim()) {
      throw new Error("Unable to read document DOM");
    }
    const docDOM = domRes.data.dom;
    const scan = scanDocumentImages(docDOM, services.origin, config);
    summary.scannedBlocks = scan.scannedBlocks;
    nestedBlockIds = scan.nestedBlockIds;
    scanned.push(...scan.occurrences);
    summary.scanComplete = true;
  } catch (error) {
    if (signal.aborted || !scope.active) return cancelledSummary(summary);
    context.logger.warn("扫描当前文档图片失败", error);
    return summary;
  }

  const authorized: AuthorizedOccurrence[] = [];
  for (const occurrence of scanned) {
    if (signal.aborted || !scope.active) return cancelledSummary(summary);
    if (nestedBlockIds.has(occurrence.blockId)) {
      summary.skipped++;
      summary.completed++;
      continue;
    }
    const target: OccurrenceTarget = {
      rootID,
      notebook: targetNotebook,
      blockID: occurrence.blockId,
      imageOrdinal: occurrence.imageOrdinal,
      oldPath: occurrence.source.raw,
    };
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
  const preparedRemoteMap = new Map<string, PreparedRemote>();
  const failedKeys = new Set<string>();
  preparedTotal = distinctGroups.length;

  // Preparation phase with bounded concurrency: desktop 3, mobile 1
  const concurrency = services.mobile ? 1 : Math.max(1, config.compression.concurrencyDesktop ?? 3);
  let nextIdx = 0;

  async function prepareWorker(): Promise<void> {
    while (nextIdx < distinctGroups.length) {
      if (signal.aborted || !scope.active) return;
      const idx = nextIdx++;
      const [key, locations] = distinctGroups[idx];
      const source = locations[0].source;
      report(source.raw);

      if (source.kind === "remote") {
        // 无扩展名远程图床链接由分类器放行后在此下载，并经 assertImagePayload / calibrateRemoteImageFile
        // 按文件头魔数验证和校准扩展名；若是无扩展名动图或矢量图，本地化后的编码阶段会将其跳过并保留本地原图。
        try {
          const { localPath, file } = await localizeRemoteAsset(services, source, verifiedRootID, signal);
          const localSource = resolveSource(localPath, services.origin);
          if (localSource.kind !== "asset") {
            throw new Error(`Unexpected localized asset kind: ${localSource.kind}`);
          }
          preparedRemoteMap.set(key, { localPath, localSource, file });
        } catch (error) {
          if (signal.aborted || !scope.active || isAbortError(error)) return;
          context.logger.warn(`下载并本地化远程图片失败：${source.raw}`, error);
          failedKeys.add(key);
        } finally {
          if (!signal.aborted && scope.active) {
            prepared++;
            report(source.raw);
          }
        }
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
        } else {
          context.logger.debug("批量压缩准备阶段跳过图片（无体积收益或规则跳过）", {
            path: source.raw,
            occurrences: locations.length,
          });
        }
      } catch (error) {
        if (signal.aborted || !scope.active || isAbortError(error)) return;
        context.logger.warn(`准备图片资源失败：${source.raw}`, error);
        failedKeys.add(key);
      } finally {
        if (!signal.aborted && scope.active) {
          prepared++;
          report(source.raw);
        }
      }
    }
  }

  const workers = Array.from({ length: Math.min(concurrency, distinctGroups.length) }, () => prepareWorker());
  await Promise.all(workers);
  if (signal.aborted || !scope.active) return cancelledSummary(summary);

  phase = "applying";
  report();

  async function applyWebpGroup(
    targets: readonly OccurrenceTarget[],
    preparedItem: Prepared,
    sourceKey: string,
    kernelPath: string,
    displayRaw: string,
  ): Promise<boolean> {
    let anyReplaced = false;
    let groupHasConflictOrUnknown = false;
    for (const target of targets) {
      if (signal.aborted || !scope.active) return false;
      try {
        const committed = await services.references.commitOccurrenceDetailed(target, preparedItem.path, signal);
        if (committed.status === "aborted") {
          return false;
        }
        logReferenceStatus({ logger: context.logger }, {
          mode: "document",
          blockID: target.blockID,
          imageOrdinal: target.imageOrdinal,
          sourcePath: kernelPath,
          compressedPath: preparedItem.path,
          reference: committed.status,
          ...(committed.status === "conflict" ? { reason: committed.conflictReason ?? "unknown" } : {}),
        });
        if (committed.status === "replaced") {
          anyReplaced = true;
          recordRewrittenReference(summary, sourceKey, preparedItem.originalBytes, preparedItem.compressedBytes, countedPaths);
        } else if (committed.status === "conflict") {
          summary.conflicts++;
          groupHasConflictOrUnknown = true;
          context.logger.debug("图片引用写回冲突，保持未完成状态", {
            blockID: target.blockID,
            imageOrdinal: target.imageOrdinal,
            path: displayRaw,
            reason: committed.conflictReason ?? "unknown",
          });
        } else if (committed.status === "failed") {
          summary.failed++;
          groupHasConflictOrUnknown = true;
          context.logger.warn(`引用写入被内核拒绝：${displayRaw}`);
        } else {
          summary.unknown++;
          groupHasConflictOrUnknown = true;
          context.logger.warn(`引用写入结果未确认：${displayRaw}`);
        }
      } catch (error) {
        if (signal.aborted || !scope.active || isAbortError(error)) return false;
        context.logger.warn(`提交图片引用失败：${displayRaw}`, error);
        summary.failed++;
        groupHasConflictOrUnknown = true;
      }
      summary.completed++;
      report(displayRaw);
    }
    await services.records.markOperation(
      kernelPath,
      preparedItem.path,
      anyReplaced && !groupHasConflictOrUnknown ? "replaced" : "incomplete",
    ).catch(() => undefined);
    return true;
  }

  // Sequential occurrence replacement phase
  for (const [key, locations] of distinctGroups) {
    if (signal.aborted || !scope.active) return cancelledSummary(summary);
    const source = locations[0].source;
    report(source.raw);

    if (failedKeys.has(key)) {
      for (const _item of locations) { summary.failed++; summary.completed++; }
      continue;
    }

    if (source.kind === "remote") {
      const remotePrepared = preparedRemoteMap.get(key);
      if (!remotePrepared) {
        for (const _item of locations) { summary.skipped++; summary.completed++; }
        continue;
      }
      const localizedTargets: OccurrenceTarget[] = [];
      const markPartialBeforeCancel = async () => {
        if (localizedTargets.length > 0) {
          await services.records.markOperation(source.url, remotePrepared.localPath, "incomplete").catch(() => undefined);
        }
      };
      for (const item of locations) {
        if (signal.aborted || !scope.active) {
          await markPartialBeforeCancel();
          return cancelledSummary(summary);
        }
        try {
          const target = item.target;
          const localized = await services.references.commitOccurrenceDetailed(target, remotePrepared.localPath, signal);
          if (localized.status === "aborted") {
            await markPartialBeforeCancel();
            return cancelledSummary(summary);
          }
          if (localized.status === "conflict") {
            summary.conflicts++;
            context.logger.debug("远程图片本地化写回冲突，跳过压缩替换", {
              blockID: target.blockID,
              imageOrdinal: target.imageOrdinal,
              path: source.raw,
              reason: localized.conflictReason ?? "unknown",
            });
            summary.completed++;
            report(source.raw);
            continue;
          }
          if (localized.status === "failed") {
            summary.failed++;
            context.logger.warn(`本地原图引用写入被内核拒绝：${source.raw}`);
            summary.completed++;
            report(source.raw);
            continue;
          }
          if (localized.status !== "replaced") {
            summary.unknown++;
            context.logger.warn(`本地原图引用写入结果未确认：${source.raw}`);
            summary.completed++;
            report(source.raw);
            continue;
          }
          const recaptured = await recaptureReplacedImageOccurrence(
            services.kernel,
            target,
            remotePrepared.localPath,
            services.origin,
            signal,
          );
          if (!recaptured) {
            summary.conflicts++;
            context.logger.debug("远程图片本地化重读后未能定位原图节点，判定冲突", {
              blockID: target.blockID,
              imageOrdinal: target.imageOrdinal,
              path: remotePrepared.localPath,
            });
            summary.completed++;
            report(source.raw);
            continue;
          }
          localizedTargets.push(recaptured);
        } catch (error) {
          if (signal.aborted || !scope.active || isAbortError(error)) {
            await markPartialBeforeCancel();
            return cancelledSummary(summary);
          }
          context.logger.warn(`更新远程图片为本地原图失败：${source.raw}`, error);
          summary.failed++;
          summary.completed++;
          report(source.raw);
        }
      }

      await services.records.markOperation(
        source.url,
        remotePrepared.localPath,
        localizedTargets.length === locations.length ? "replaced" : "incomplete",
      ).catch(() => undefined);

      if (!localizedTargets.length) continue;

      let webpPrepared: Prepared | undefined;
      try {
        const encoded = await services.compressOccurrence(localizedTargets[0], config, signal, {
          replace: false,
          mode: "document",
          providedFile: remotePrepared.file,
        });
        if (encoded.status === "saved") {
          const origBytes = encoded.originalBytes ?? 0;
          const compBytes = encoded.compressedBytes ?? 0;
          webpPrepared = {
            path: encoded.path,
            originalBytes: origBytes,
            compressedBytes: compBytes,
            quality: encoded.quality,
            similarity: encoded.similarity,
          };
          uploaded++;
          summary.originalBytes += origBytes;
          summary.compressedBytes += compBytes;
        }
      } catch (error) {
        if (signal.aborted || !scope.active || isAbortError(error)) return cancelledSummary(summary);
        context.logger.warn(`压缩本地化后的远程图片失败：${source.raw}`, error);
        for (const _loc of localizedTargets) { summary.failed++; summary.completed++; }
        report(source.raw);
        continue;
      }

      if (!webpPrepared) {
        for (const _loc of localizedTargets) { summary.skipped++; summary.completed++; }
        report(source.raw);
        continue;
      }

      const continued = await applyWebpGroup(
        localizedTargets,
        webpPrepared,
        remotePrepared.localSource.key,
        remotePrepared.localSource.kernelPath,
        source.raw,
      );
      if (!continued) return cancelledSummary(summary);
      continue;
    }

    const preparedItem = preparedMap.get(key);
    if (!preparedItem) {
      for (const _item of locations) { summary.skipped++; summary.completed++; }
      continue;
    }

    const continued = await applyWebpGroup(
      locations.map(item => item.target),
      preparedItem,
      source.key,
      source.kernelPath,
      source.raw,
    );
    if (!continued) return cancelledSummary(summary);
  }

  summary.uploaded = uploaded;
  report();
  return summary;
}

function cancelledSummary(summary: CompressionBatchSummary): CompressionBatchSummary { summary.cancelled = true; return summary; }
