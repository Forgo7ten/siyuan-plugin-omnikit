import { showMessage } from "siyuan";
import type { FeatureContext } from "../../core/FeatureContext.ts";
import type { FeatureScope } from "../../core/FeatureScope.ts";
import { AssetRepository } from "./AssetRepository.ts";
import { ImageCompressorService } from "./ImageCompressorService.ts";
import type { ImageSettings } from "./settings.ts";
import { imageReferenceParser } from "./ImageReferenceParser.ts";
import { translate } from "../../i18n/translate.ts";

/** @safety Writes only the exact same-path image occurrence that was right-clicked. */
export async function compressSelectedImage(detail: any, context: FeatureContext, scope: FeatureScope, settings: ImageSettings, service: ImageCompressorService): Promise<void> {
  const targetImage = findTargetImage(detail);
  const protyle = detail?.protyle ?? detail?.editor?.protyle;
  const block = targetImage?.closest("[data-node-id]") as HTMLElement | null;
  const blockId = block?.getAttribute("data-node-id");
  const rootId = protyle?.block?.rootID;
  const sourcePath = targetImage?.getAttribute("data-src") || targetImage?.getAttribute("src");
  if (!scope.active || !targetImage || !blockId || !rootId || protyle?.disabled || !isLocalAsset(sourcePath)) {
    context.logger.debug("拒绝压缩单张图片", {
      功能启用: scope.active,
      存在目标图片: Boolean(targetImage),
      图片块ID: blockId,
      文档根ID: rootId,
      编辑器已禁用: protyle?.disabled,
      属于本地资源: isLocalAsset(sourcePath),
      资源路径: sourcePath,
    });
    showMessage(translate(context.plugin.i18n, "image.single.invalidTarget"), 5000); return;
  }

  const siblings = Array.from(block!.querySelectorAll("img"));
  const occurrenceIndex = siblings.slice(0, siblings.indexOf(targetImage)).filter(image => (image.getAttribute("data-src") || image.getAttribute("src")) === sourcePath).length;
  const selectedElementPath = sourcePath;
  const repository = new AssetRepository();
  const initialDom = await repository.getBlockDOM(blockId);
  const initialRefs = imageReferenceParser.scan(initialDom, blockId).filter(ref => ref.url === sourcePath);
  const expectedCount = initialRefs.length;
  const selectedRef = initialRefs[occurrenceIndex];
  if (!selectedRef || expectedCount !== siblings.filter(image => (image.getAttribute("data-src") || image.getAttribute("src")) === sourcePath).length) {
    showMessage(translate(context.plugin.i18n, "image.single.unmappable"), 5000); return;
  }

  const signal = scope.signal;
  try {
    const response = await fetch(targetImage.currentSrc || sourcePath, { signal });
    if (!response.ok) throw new Error(`读取原图片失败，HTTP ${response.status}`);
    const sourceBlob = await response.blob();
    const compressed = await service.compress(sourceBlob, sourcePath, settings, signal);
    if (!compressed) { showMessage(translate(context.plugin.i18n, "image.single.noBenefit"), 4000); return; }
    if (!scope.active) return;

    const nextPath = await repository.upload(compressed.blob, rootId, sourcePath, signal);
    if (!scope.active || signal.aborted) return;

    // @invariant Re-read just before write and reject any count or selected-tag change.
    const latestDom = await repository.getBlockDOM(blockId);
    if (!scope.active) return;
    const rewritten = imageReferenceParser.replaceOne(latestDom, selectedRef, nextPath);
    if (!rewritten.ok) { showMessage(translate(context.plugin.i18n, "image.single.conflict"), 5000); return; }
    if (!scope.active || signal.aborted) return;
    await repository.updateBlockDOM(blockId, rewritten.markdown, signal);
    if (targetImage.isConnected && (targetImage.getAttribute("data-src") || targetImage.getAttribute("src")) === selectedElementPath) {
      targetImage.setAttribute("src", nextPath); targetImage.setAttribute("data-src", nextPath);
    }
    showMessage(translate(context.plugin.i18n, "image.single.success", {
      original: formatBytes(compressed.originalBytes),
      compressed: formatBytes(compressed.compressedBytes),
    }), 5000);
    context.logger.debug("单张图片压缩完成", {
      文档根ID: rootId,
      图片块ID: blockId,
      原资源路径: sourcePath,
      新资源路径: nextPath,
      原大小: compressed.originalBytes,
      压缩后大小: compressed.compressedBytes,
    });
  } catch (error) {
    if (!signal.aborted) { context.logger.warn("压缩所选图片失败", error); showMessage(translate(context.plugin.i18n, "image.single.failed"), 5000); }
  }
}

function findTargetImage(detail: any): HTMLImageElement | undefined {
  const element = detail?.element as HTMLElement | undefined;
  if (element instanceof HTMLImageElement) return element;
  return (element?.matches("img") ? element : element?.querySelector("img")) as HTMLImageElement | null ?? undefined;
}
function isLocalAsset(path: string | null | undefined): path is string { return !!path && /^assets\//i.test(path) && !/[?#]/.test(path); }
function formatBytes(size: number): string { return size < 1024 ? `${size} B` : `${(size / 1024).toFixed(1)} KB`; }
