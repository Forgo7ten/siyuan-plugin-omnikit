import { isInsideProtectedContainer } from "../../../core/host/dom.ts";
import { isAbortError } from "../../../core/feedback/UiFeedback.ts";
import type { FeatureContext } from "../../../core/framework/FeatureContext.ts";
import type { FeatureScope } from "../../../core/framework/FeatureScope.ts";
import { blockDOM } from "../services/references.ts";
import { resolveImageOccurrence, imagePath, type ImageOccurrenceEvidence } from "../services/ImageOccurrenceResolver.ts";
import type { OccurrenceTarget } from "../policy/contracts.ts";
import type { ImageProcessingServices } from "../services/ImageProcessingServices.ts";
import type { Downloaded } from "../services/download.ts";
import { NODE_ID } from "../policy/parseImageConfig.ts";
import { buildReplacementPath, resolveSource } from "../policy/source.ts";
import { assertImagePayload, calibrateRemoteImageFile } from "./RemoteImageWatcher.ts";
import { classifyImageCandidate } from "../policy/ImageCandidateClassifier.ts";
import type { CommitResult } from "../services/SafeBlockWriter.ts";
import { translate } from "../../../i18n/translate.ts";

export type ImageActionOutcome =
  | { kind: "notify"; key: string; values?: Record<string, string | number> }
  | { kind: "copyable-path"; path: string; key: string }
  | { kind: "silent" };

export interface SingleImageEditorContext {
  rootID: string;
  notebook: string;
  disabled?: boolean;
}

export interface ManualCompressionPreview {
  file: File;
  originalBlob: Blob;
  originalBytes: number;
  compressedBytes: number;
  width: number;
  height: number;
  quality?: number;
  similarity?: number;
  targetSimilarity?: number;
  searchRounds?: Array<{ quality: number; similarity: number; bytes: number }>;
}

export class LocalizationOutcomeError extends Error {
  constructor(
    readonly outcome: "unknown" | "conflict" | "failed",
    readonly localPath?: string,
  ) {
    super(`Remote image localization ended with ${outcome}`);
    this.name = "LocalizationOutcomeError";
  }
}

/** Captures the right-clicked image as one exact persisted occurrence. */
export async function resolveSelectedOccurrence(
  menuDetail: unknown,
  editor: SingleImageEditorContext,
  services: ImageProcessingServices,
  signal: AbortSignal,
): Promise<OccurrenceTarget | undefined> {
  const image = findTargetImage(menuDetail);
  if (!image || isInsideProtectedContainer(image)) {
    return undefined;
  }
  const owner = image.closest("[data-node-id]");
  const blockID = owner?.getAttribute("data-node-id");
  const images = owner ? [...owner.querySelectorAll("img")] : [];
  const imageOrdinal = images.indexOf(image);
  const oldPath = imagePath(image);
  if (!blockID || !NODE_ID.test(blockID) || !NODE_ID.test(editor.rootID)
    || !NODE_ID.test(editor.notebook) || imageOrdinal < 0 || !oldPath || editor.disabled) return undefined;

  const evidence: ImageOccurrenceEvidence = {
    rootID: editor.rootID,
    notebook: editor.notebook,
    blockID,
    imageOrdinal,
    oldPath,
  };
  const dom = await blockDOM(services.kernel, blockID, editor.notebook, signal);
  return resolveImageOccurrence(dom, evidence);
}

/**
 * Re-reads the persisted block after localization via kernel API and rebuilds a fresh
 * `OccurrenceTarget` with the updated `baselineBlockDOM` and `oldPath`.
 */
export async function revalidateAndRecaptureTarget(
  previous: OccurrenceTarget,
  expectedNewPath: string,
  services: ImageProcessingServices,
  signal: AbortSignal,
): Promise<OccurrenceTarget | undefined> {
  const dom = await blockDOM(services.kernel, previous.blockID, previous.notebook, signal);
  return resolveImageOccurrence(dom, {
    rootID: previous.rootID,
    notebook: previous.notebook,
    blockID: previous.blockID,
    imageOrdinal: previous.imageOrdinal,
    oldPath: expectedNewPath,
  });
}

/** The quick action uses defaults and changes only the clicked occurrence. */
export async function compressSelectedImageQuick(
  menuDetail: unknown,
  context: FeatureContext,
  scope: FeatureScope,
  editor: SingleImageEditorContext,
  services: ImageProcessingServices,
): Promise<ImageActionOutcome | void> {
  const signal = scope.signal;
  if (!scope.active || signal.aborted) return;
  if (editor.disabled) return { kind: "notify", key: "image.single.invalidTarget" };
  try {
    let target = await resolveSelectedOccurrence(menuDetail, editor, services, signal);
    if (!scope.active || signal.aborted) return;
    if (!target) return { kind: "notify", key: "image.single.unmappable" };
    const candidateDecision = classifyImageCandidate({
      path: target.oldPath,
      mode: "manual-quick",
      excludedExtensions: services.config().compression.excludedExtensions,
      smartEnabled: services.config().compression.smartEnabled === true,
    });
    if (!candidateDecision.eligible) return { kind: "notify", key: "image.single.noBenefit" };
    // 快捷压缩：无扩展名远程图床链接经分类器放行后，先本地化下载、魔数校验并上传原图，
    // 再进入压缩流程；若实际为无扩展名动图或矢量图，将在压缩检查阶段跳过并保留本地原图。
    let providedFile: File | undefined;
    target = await localizeRemoteOccurrence(target, services, signal, true, undefined, file => {
      providedFile = file;
    });
    if (!scope.active || signal.aborted) return;
    const result = await services.compressOccurrence(target, services.config(), signal, {
      replace: true,
      mode: "manual-quick",
      ...(providedFile ? { providedFile } : {}),
    });
    if (!scope.active || signal.aborted) return;
    if (result.status === "skipped") return { kind: "notify", key: "image.single.noBenefit" };
    const ref = result.reference as CommitResult | "not-requested";
    if (ref === "aborted") return { kind: "silent" };
    const outcomeKey = ref === "replaced"
      ? "image.single.quickSuccess"
      : ref === "unknown"
        ? "image.single.unknown"
        : ref === "failed"
          ? "image.single.failed"
          : "image.single.conflict";
    return { kind: "notify", key: outcomeKey };
  } catch (error) {
    if (error instanceof LocalizationOutcomeError) {
      if (error.outcome === "unknown") {
        return error.localPath
          ? { kind: "copyable-path", path: error.localPath, key: "image.single.unknown" }
          : { kind: "notify", key: "image.single.unknown" };
      }
      if (error.outcome === "failed") {
        return { kind: "notify", key: "image.single.failed" };
      }
      return { kind: "notify", key: "image.single.conflict" };
    }
    if (!signal.aborted && !isAbortError(error)) {
      context.logger.warn("压缩所选图片失败", error);
      return {
        kind: "notify",
        key: "image.single.failed",
      };
    }
  }
}

/** Opens an in-memory preview; uploading and writing occur only after explicit save. */
export async function compressSelectedImageCustom(
  menuDetail: unknown,
  context: FeatureContext,
  scope: FeatureScope,
  editor: SingleImageEditorContext,
  services: ImageProcessingServices,
): Promise<ImageActionOutcome | void> {
  const signal = scope.signal;
  if (!scope.active || signal.aborted) return;
  if (editor.disabled) return { kind: "notify", key: "image.single.invalidTarget" };
  try {
    const target = await resolveSelectedOccurrence(menuDetail, editor, services, signal);
    if (!scope.active || signal.aborted) return;
    if (!target) return { kind: "notify", key: "image.single.unmappable" };
    const candidateDecision = classifyImageCandidate({
      path: target.oldPath,
      mode: "manual-dialog",
      excludedExtensions: services.config().compression.excludedExtensions,
      smartEnabled: services.config().compression.smartEnabled === true,
    });
    if (!candidateDecision.eligible) return { kind: "notify", key: "image.single.noBenefit" };
    const source = resolveSource(target.oldPath, services.origin);
    const config = services.config();
    let previewOriginal: Downloaded | undefined;
    const previewAbort = new AbortController();
    const relayAbort = () => previewAbort.abort(signal.reason);
    const onClose = () => {
      signal.removeEventListener("abort", relayAbort);
      previewAbort.abort(new DOMException("Preview closed", "AbortError"));
    };
    signal.addEventListener("abort", relayAbort, { once: true });
    try {
      services.ui.manualCompression({
        sourceName: source.name,
        defaults: {
          quality: config.compression.initialQuality,
          manualMaxEdge: config.compression.manualMaxEdge,
        },
        previewEncode: async (quality, manualMaxEdge) => {
          const tunedConfig = {
            ...config,
            compression: { ...config.compression, initialQuality: quality, manualMaxEdge },
          };
          // 自定义压缩对话框在预览阶段先行下载远程图片并做魔数校验与编码测试，不上传或修改文档；
          // 仅在用户点击保存后才执行本地化上传与文档引用更新（无扩展名动图/矢量图在此即被拦截）。
          const rawOriginal = previewOriginal ?? await services.reader.read(source, {
            maxBytes: source.kind === "remote" ? Math.min(config.compression.maxInputBytes, 32 * 1024 * 1024) : config.compression.maxInputBytes,
            timeoutMs: 30_000,
            signal: previewAbort.signal,
            userAgent: services.userAgent(),
          });
          let original = rawOriginal;
          if (!previewOriginal && source.kind === "remote") {
            await assertImagePayload(rawOriginal.blob);
            const calibrated = await calibrateRemoteImageFile(rawOriginal.blob, rawOriginal.name);
            original = { blob: calibrated, name: calibrated.name };
          }
          previewOriginal = original;
          const encoded = await services.encoder.encode(original.blob, original.name, tunedConfig,
            previewAbort.signal, undefined, "manual-dialog");
          if (encoded.kind === "skipped") throw new Error(encoded.reason);
          return {
            file: encoded.value.file,
            originalBlob: original.blob,
            originalBytes: original.blob.size,
            compressedBytes: encoded.value.file.size,
            width: encoded.value.width,
            height: encoded.value.height,
            quality: encoded.value.quality,
            similarity: encoded.value.similarity,
            targetSimilarity: encoded.value.targetSimilarity,
            searchRounds: encoded.value.searchRounds,
          } satisfies ManualCompressionPreview;
        },
        save: async (preview, replace) => {
          if (!scope.active || signal.aborted) return;
          const metrics = {
            originalBytes: preview.originalBytes,
            compressedBytes: preview.compressedBytes,
            quality: preview.quality,
            similarity: preview.similarity,
          };
          let localizedTarget: OccurrenceTarget;
          try {
            // For remote sources, always localize the single selected occurrence to a local original first
            // even when `replace` (WebP replacement) is unchecked.
            localizedTarget = await localizeRemoteOccurrence(target, services, signal, true, previewOriginal);
          } catch (error) {
            if (error instanceof LocalizationOutcomeError) {
              if (error.outcome === "unknown") {
                if (error.localPath) {
                  services.ui.copyablePath(error.localPath, "image.single.unknown");
                } else {
                  services.ui.notify(translate(context.plugin.i18n as Record<string, unknown>, "image.single.unknown"));
                }
                return;
              }
              if (error.outcome === "failed") {
                services.ui.notify(translate(context.plugin.i18n as Record<string, unknown>, "image.single.failed"));
                return;
              }
              services.ui.notify(translate(context.plugin.i18n as Record<string, unknown>, "image.single.conflict"));
              return;
            }
            throw error;
          }
          if (!scope.active || signal.aborted) return;
          const result = await services.savePreview(localizedTarget, preview.file, signal, replace, metrics);
          if (!scope.active || signal.aborted || result.status !== "saved") return;
          const ref = result.reference as CommitResult | "not-requested";
          if (ref === "aborted") return;
          if (ref === "unknown") {
            services.ui.copyablePath(result.path, "image.single.unknown");
          } else if (ref === "conflict") {
            services.ui.copyablePath(result.path, "image.single.conflict");
          } else if (ref === "failed") {
            services.ui.copyablePath(result.path, "image.single.failed");
          } else if (!replace || ref === "not-requested") {
            services.ui.copyablePath(result.path, "image.dialog.savedOnly");
          } else if (ref === "replaced") {
            services.ui.notify(translate(context.plugin.i18n as Record<string, unknown>, "image.single.quickSuccess"));
          } else {
            services.ui.copyablePath(result.path, "image.single.conflict");
          }
        },
        onClose,
      });
    } catch (error) {
      onClose();
      throw error;
    }
  } catch (error) {
    if (!signal.aborted && !isAbortError(error)) {
      context.logger.warn("准备单图压缩预览失败", error);
      return {
        kind: "notify",
        key: "image.single.failed",
      };
    }
  }
}

export async function localizeRemoteOccurrence(
  target: OccurrenceTarget,
  services: ImageProcessingServices,
  signal: AbortSignal,
  _replace: boolean = true,
  suppliedOriginal?: Downloaded,
  onFile?: (file: File) => void,
): Promise<OccurrenceTarget> {
  const source = resolveSource(target.oldPath, services.origin);
  if (source.kind !== "remote") return target;
  const config = services.config();
  const original = suppliedOriginal ?? await services.reader.read(source, {
    maxBytes: Math.min(config.compression.maxInputBytes, 32 * 1024 * 1024),
    timeoutMs: 30_000,
    signal,
    userAgent: services.userAgent(),
  });
  await assertImagePayload(original.blob);
  const file = await calibrateRemoteImageFile(original.blob, original.name);
  const localPath = await services.assets.upload(file, target.rootID, signal);
  onFile?.(file);
  const committed = await services.references.commitOccurrence(target, localPath, signal);
  if (committed === "aborted") {
    throw new DOMException("Aborted", "AbortError");
  }
  if (committed === "unknown") {
    throw new LocalizationOutcomeError("unknown", localPath);
  }
  if (committed === "failed") {
    throw new LocalizationOutcomeError("failed", localPath);
  }
  if (committed !== "replaced") {
    throw new LocalizationOutcomeError("conflict", localPath);
  }
  const expectedLocalPath = buildReplacementPath(target.oldPath, localPath, services.origin);
  const recaptured = await revalidateAndRecaptureTarget(target, expectedLocalPath, services, signal);
  if (!recaptured) {
    throw new LocalizationOutcomeError("conflict", localPath);
  }
  return recaptured;
}

function findTargetImage(detail: unknown): HTMLImageElement | undefined {
  const element = (detail as any)?.element as HTMLElement | undefined;
  if (typeof HTMLImageElement !== "undefined" && element instanceof HTMLImageElement) return element;
  return (element?.matches("img") ? element : element?.querySelector("img")) as HTMLImageElement | null ?? undefined;
}
