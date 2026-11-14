import { showMessage } from "siyuan";
import type { FeatureContext } from "../../core/FeatureContext.ts";
import type { FeatureScope } from "../../core/FeatureScope.ts";
import { translate } from "../../i18n/translate.ts";
import { recordRewrittenReference, type CompressionBatchSummary, type CompressionProgress } from "./CompressionResult.ts";
import { isDocumentRootIdentity } from "./DocumentIdentity.ts";
import type { ImageProcessingServices } from "./ImageProcessingServices.ts";
import { resolveSource, type ImageSource } from "./source.ts";
import type { OccurrenceTarget } from "./contracts.ts";
import { resolveImageOccurrence } from "./ImageOccurrenceResolver.ts";
import { scanDocumentImages, type DocumentImageOccurrence } from "./scanDocumentImages.ts";

export interface BatchActionOptions {
  signal?: AbortSignal;
  onProgress?: (progress: CompressionProgress) => void;
}

interface AuthorizedOccurrence { target: OccurrenceTarget; source: ImageSource }
interface Prepared { path: string; originalBytes: number; compressedBytes: number }

/** Compresses one document's assets once each, then commits only its captured occurrences. */
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
  let scanned: DocumentImageOccurrence[];
  try {
    const identity = await services.kernel.post<any>("/api/block/getBlockInfo", { id: rootID, ...(editorNotebook ? { notebook: editorNotebook } : {}) }, { signal });
    if (!isDocumentRootIdentity(identity.data, rootID)) throw new Error("Unable to verify document identity");
    if (editorNotebook && identity.data?.box && editorNotebook !== identity.data.box) throw new Error("Document notebook changed");
    notebook = editorNotebook || identity.data?.box || protyle?.block?.box || "";
    if (!notebook) throw new Error("Document notebook is unavailable");
    const response = await services.kernel.post<any>("/api/block/getBlockDOM", { id: rootID, notebook }, { signal });
    if (response.data?.id !== rootID || typeof response.data.dom !== "string" || !response.data.dom.trim()) throw new Error("Invalid document DOM");
    const scan = scanDocumentImages(response.data.dom, services.origin, config);
    scanned = scan.occurrences;
    summary.scannedBlocks = scan.scannedBlocks;
    summary.scanComplete = true;
  } catch (error) {
    if (signal.aborted || !scope.active) return cancelledSummary(summary);
    context.logger.warn("扫描当前文档图片失败", error);
    showMessage(translate(context.plugin.i18n, "image.batch.scanFailed"), 5000);
    return summary;
  }

  // Every block snapshot is fetched once before compression begins; these are the authorized targets.
  const targetNotebook = notebook;
  const blockDOMs = new Map<string, string>();
  const authorized: AuthorizedOccurrence[] = [];
  for (const occurrence of scanned) {
    if (signal.aborted || !scope.active) return cancelledSummary(summary);
    let dom = blockDOMs.get(occurrence.blockId);
    if (!dom) {
      try {
        const response = await services.kernel.post<any>("/api/block/getBlockDOM", { id: occurrence.blockId, notebook: targetNotebook }, { signal });
        if (response.data?.id !== occurrence.blockId || typeof response.data.dom !== "string" || !response.data.dom.trim()) throw new Error("Invalid image block DOM");
        const blockDOM = response.data.dom as string;
        dom = blockDOM;
        blockDOMs.set(occurrence.blockId, blockDOM);
      } catch (error) {
        context.logger.warn(`读取图片块失败：${occurrence.blockId}`, error);
        summary.failed++;
        summary.completed++;
        continue;
      }
    }
    if (!dom) continue;
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
    showMessage(translate(context.plugin.i18n, "image.batch.noImages"), 4000);
    return summary;
  }

  const byKey = new Map<string, AuthorizedOccurrence[]>();
  for (const item of authorized) {
    const group = byKey.get(item.source.key) ?? [];
    group.push(item);
    byKey.set(item.source.key, group);
  }
  const countedPaths = new Set<string>();
  const alreadyWritten = new Map<string, Map<number, { oldPath: string; newPath: string }>>();
  let uploaded = 0;
  for (const [, locations] of byKey) {
    if (signal.aborted || !scope.active) return cancelledSummary(summary);
    const source = locations[0].source;
    report(source.raw);
    if (source.kind !== "asset" || source.box) {
      // Encrypted notebook asset writes are deliberately refused until updateBlock supports scoped routing.
      for (const _item of locations) { summary.skipped++; summary.completed++; }
      continue;
    }

    let prepared: Prepared | undefined;
    try {
      const result = await services.compressOccurrence(locations[0].target, config, signal, {
        replace: false, mode: "document",
      });
      if (result.status === "saved") {
        prepared = { path: result.path, originalBytes: 0, compressedBytes: 0 };
        uploaded++;
        try {
          const readOptions = { maxBytes: config.compression.maxInputBytes, timeoutMs: 30_000, signal };
          const original = await services.reader.read(source, readOptions);
          const compressed = await services.reader.read(resolveSource(result.path, services.origin), readOptions);
          prepared.originalBytes = original.blob.size;
          prepared.compressedBytes = compressed.blob.size;
          summary.originalBytes += original.blob.size;
          summary.compressedBytes += compressed.blob.size;
        } catch (error) {
          context.logger.warn(`读取压缩后图片大小失败：${source.raw}`, error);
        }
      }
    } catch (error) {
      if (signal.aborted || !scope.active) return cancelledSummary(summary);
      context.logger.warn(`准备图片资源失败：${source.raw}`, error);
      for (const _item of locations) { summary.failed++; summary.completed++; }
      continue;
    }
    if (!prepared) {
      for (const _item of locations) { summary.skipped++; summary.completed++; }
      continue;
    }

    // Re-read after each verified write. Rebase only the original authorized locations when
    // the block equals the exact result of our prior authorized writes; concurrent edits stop it.
    let anyReplaced = false;
    for (const item of locations) {
      if (signal.aborted || !scope.active) return cancelledSummary(summary);
      let target = item.target;
      const replacements = alreadyWritten.get(target.blockID);
      if (replacements?.size) {
        const expected = patchAuthorizedBaseline(target.baselineBlockDOM, target.blockID, replacements);
        if (!expected) {
          summary.conflicts++; summary.completed++;
          continue;
        }
        try {
          const current = await readBlockDOM(services, target.blockID, targetNotebook, signal);
          if (canonicalBlock(current, target.blockID) !== expected) {
            summary.conflicts++; summary.completed++;
            continue;
          }
          target = { ...target, baselineBlockDOM: current };
          item.target = target;
          for (const later of locations) if (later.target.blockID === target.blockID && !replacements.has(later.target.imageOrdinal)) {
            later.target = { ...later.target, baselineBlockDOM: current };
          }
        } catch (error) {
          context.logger.warn(`复核图片块失败：${target.blockID}`, error);
          summary.conflicts++; summary.completed++;
          continue;
        }
      }
      try {
        const committed = await services.references.commitOccurrence(target, prepared.path, signal);
        if (committed === "replaced") {
          anyReplaced = true;
          const allowed = alreadyWritten.get(target.blockID) ?? new Map<number, { oldPath: string; newPath: string }>();
          allowed.set(target.imageOrdinal, { oldPath: target.oldPath, newPath: prepared.path });
          alreadyWritten.set(target.blockID, allowed);
          // Read back immediately. Only advance baselines if the block contains our exact authorized patch.
          try {
            const after = await readBlockDOM(services, target.blockID, targetNotebook, signal);
            const expected = patchAuthorizedBaseline(target.baselineBlockDOM, target.blockID, allowed);
            if (!expected || canonicalBlock(after, target.blockID) !== expected) {
              summary.conflicts++; summary.completed++;
              continue;
            }
            blockDOMs.set(target.blockID, after);
            for (const later of locations) if (later.target.blockID === target.blockID && !allowed.has(later.target.imageOrdinal)) {
              later.target = { ...later.target, baselineBlockDOM: after };
            }
          } catch (error) {
            context.logger.warn(`图片块写回后验证失败：${target.blockID}`, error);
            summary.failed++; summary.completed++;
            continue;
          }
          recordRewrittenReference(summary, source.raw, prepared.originalBytes, prepared.compressedBytes, countedPaths);
        } else if (committed === "conflict") summary.conflicts++;
        else summary.failed++;
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
  showComplete(context, summary);
  report();
  return summary;
}

async function readBlockDOM(services: ImageProcessingServices, id: string, notebook: string, signal: AbortSignal): Promise<string> {
  const response = await services.kernel.post<any>("/api/block/getBlockDOM", { id, notebook }, { signal });
  if (response.data?.id !== id || typeof response.data.dom !== "string" || !response.data.dom.trim()) throw new Error("Invalid block DOM");
  return response.data.dom;
}

function canonicalBlock(dom: string, blockID: string): string | undefined {
  const parsed = new DOMParser().parseFromString(dom, "text/html");
  if (parsed.querySelector("parsererror")) return undefined;
  const roots = [...parsed.body.children].filter(node => node.getAttribute("data-node-id") === blockID);
  if (roots.length !== 1 || parsed.body.children.length !== 1 || roots[0].querySelector("[data-node-id]")) return undefined;
  return roots[0].outerHTML;
}

function patchAuthorizedBaseline(dom: string, blockID: string, replacements: Map<number, { oldPath: string; newPath: string }>): string | undefined {
  const canonical = canonicalBlock(dom, blockID);
  if (!canonical) return undefined;
  const template = document.createElement("template");
  template.innerHTML = canonical;
  const root = template.content.children[0];
  const images = [...root.querySelectorAll("img")];
  for (const [ordinal, replacement] of replacements) {
    const image = images[ordinal];
    if (!image) return undefined;
    const attr = image.hasAttribute("data-src") ? "data-src" : "src";
    const current = image.getAttribute(attr);
    if (current === replacement.oldPath) {
      image.setAttribute(attr, replacement.newPath);
      if (attr === "data-src" && image.getAttribute("src") === replacement.oldPath) image.setAttribute("src", replacement.newPath);
    } else if (current !== replacement.newPath) {
      return undefined;
    }
  }
  return root.outerHTML;
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
