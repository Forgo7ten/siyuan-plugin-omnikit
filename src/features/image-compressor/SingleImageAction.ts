import type { FeatureContext } from "../../core/FeatureContext.ts";
import type { FeatureScope } from "../../core/FeatureScope.ts";
import { translate } from "../../i18n/translate.ts";
import { blockDOM } from "./references.ts";
import { resolveImageOccurrence, type ImageOccurrenceEvidence } from "./ImageOccurrenceResolver.ts";
import type { OccurrenceTarget } from "./contracts.ts";
import type { ImageProcessingServices } from "./ImageProcessingServices.ts";
import type { Downloaded } from "./download.ts";
import { NODE_ID } from "./parseImageConfig.ts";
import { resolveSource } from "./source.ts";
import { imagePath } from "./ImageOccurrenceResolver.ts";
import { assertImagePayload, safeFileName } from "./RemoteImageWatcher.ts";

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
}

/** Captures the right-clicked image as one exact persisted occurrence. */
export async function resolveSelectedOccurrence(
  menuDetail: unknown,
  editor: SingleImageEditorContext,
  services: ImageProcessingServices,
  signal: AbortSignal,
): Promise<OccurrenceTarget | undefined> {
  const image = findTargetImage(menuDetail);
  const owner = image?.closest("[data-node-id]");
  const blockID = owner?.getAttribute("data-node-id");
  const images = owner ? [...owner.querySelectorAll("img")] : [];
  const imageOrdinal = image ? images.indexOf(image) : -1;
  const oldPath = image ? imagePath(image) : undefined;
  if (!image || !blockID || !NODE_ID.test(blockID) || !NODE_ID.test(editor.rootID)
    || !NODE_ID.test(editor.notebook) || imageOrdinal < 0 || !oldPath || editor.disabled) return undefined;

  const evidence: ImageOccurrenceEvidence = {
    rootID: editor.rootID,
    notebook: editor.notebook,
    blockID,
    imageOrdinal,
    oldPath,
  };
  const dom = await blockDOM(services.kernel, blockID, editor.notebook, signal);
  const target = resolveImageOccurrence(dom, evidence);
  if (!target) return undefined;
  const info = (await services.kernel.post<{ rootID?: string; box?: string }>(
    "/api/block/getBlockInfo", { id: blockID, notebook: editor.notebook }, { signal },
  )).data;
  if (info?.rootID !== editor.rootID || info.box !== editor.notebook) return undefined;
  return target;
}

/** The quick action uses defaults and changes only the clicked occurrence. */
export async function compressSelectedImageQuick(
  menuDetail: unknown,
  context: FeatureContext,
  scope: FeatureScope,
  editor: SingleImageEditorContext,
  services: ImageProcessingServices,
): Promise<void> {
  const signal = scope.signal;
  if (!scope.active || signal.aborted) return;
  if (editor.disabled) return notify(context, services, "image.single.invalidTarget");
  try {
    let target = await resolveSelectedOccurrence(menuDetail, editor, services, signal);
    if (!scope.active || signal.aborted) return;
    if (!target) return notify(context, services, "image.single.unmappable");
    target = await localizeRemoteOccurrence(target, services, signal);
    if (!scope.active || signal.aborted) return;
    const result = await services.compressOccurrence(target, services.config(), signal, {
      replace: true,
      mode: "manual-quick",
    });
    if (!scope.active || signal.aborted) return;
    services.ui.notify(result.status === "skipped"
      ? translate(context.plugin.i18n, "image.single.noBenefit")
      : result.reference === "replaced"
        ? translate(context.plugin.i18n, "image.single.quickSuccess")
        : translate(context.plugin.i18n, "image.single.conflict"));
  } catch (error) {
    if (!signal.aborted) {
      context.logger.warn("压缩所选图片失败", error);
      services.ui.notify(translate(context.plugin.i18n, "image.single.failed"));
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
): Promise<void> {
  const signal = scope.signal;
  if (!scope.active || signal.aborted) return;
  if (editor.disabled) return notify(context, services, "image.single.invalidTarget");
  try {
    const target = await resolveSelectedOccurrence(menuDetail, editor, services, signal);
    if (!scope.active || signal.aborted) return;
    if (!target) return notify(context, services, "image.single.unmappable");
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
          const original = await services.reader.read(source, {
            maxBytes: source.kind === "remote" ? Math.min(config.compression.maxInputBytes, 32 * 1024 * 1024) : config.compression.maxInputBytes,
            timeoutMs: 30_000,
            signal: previewAbort.signal,
            userAgent: config.remote.downloadUserAgent,
          });
          if (source.kind === "remote") await assertImagePayload(original.blob);
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
          } satisfies ManualCompressionPreview;
        },
        save: async (preview, replace) => {
          if (!scope.active || signal.aborted) return;
          const localizedTarget = await localizeRemoteOccurrence(target, services, signal, previewOriginal);
          const result = await services.savePreview(localizedTarget, preview.file, signal, replace);
          if (result.status === "saved" && result.reference === "conflict") {
            services.ui.copyablePath(result.path, "image.single.conflict");
          } else if (result.status === "saved" && !replace) {
            services.ui.copyablePath(result.path, "image.dialog.savedOnly");
          } else if (result.status === "saved" && result.reference === "replaced") {
            services.ui.notify(translate(context.plugin.i18n, "image.single.quickSuccess"));
          } else if (result.status === "saved") {
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
    if (!signal.aborted) {
      context.logger.warn("准备单图压缩预览失败", error);
      services.ui.notify(translate(context.plugin.i18n, "image.single.failed"));
    }
  }
}

async function localizeRemoteOccurrence(
  target: OccurrenceTarget,
  services: ImageProcessingServices,
  signal: AbortSignal,
  suppliedOriginal?: Downloaded,
): Promise<OccurrenceTarget> {
  const source = resolveSource(target.oldPath, services.origin);
  if (source.kind !== "remote") return target;
  const config = services.config();
  const original = suppliedOriginal ?? await services.reader.read(source, {
    maxBytes: Math.min(config.compression.maxInputBytes, 32 * 1024 * 1024),
    timeoutMs: 30_000,
    signal,
    userAgent: config.remote.downloadUserAgent,
  });
  await assertImagePayload(original.blob);
  const file = new File([original.blob], safeFileName(original.name), { type: original.blob.type });
  const localPath = await services.assets.upload(file, target.rootID, signal);
  const committed = await services.references.commitOccurrence(target, localPath, signal);
  if (committed !== "replaced") throw new Error("Remote image localization could not be verified");
  const updatedDOM = await blockDOM(services.kernel, target.blockID, target.notebook, signal);
  const evidence = { ...target, oldPath: localPath };
  const updatedTarget = resolveImageOccurrence(updatedDOM, evidence);
  if (!updatedTarget) throw new Error("Localized image occurrence could not be re-read");
  return updatedTarget;
}

function notify(context: FeatureContext, services: ImageProcessingServices, key: string): void {
  services.ui.notify(translate(context.plugin.i18n, key));
}

function findTargetImage(detail: unknown): HTMLImageElement | undefined {
  const element = (detail as any)?.element as HTMLElement | undefined;
  if (typeof HTMLImageElement !== "undefined" && element instanceof HTMLImageElement) return element;
  return (element?.matches("img") ? element : element?.querySelector("img")) as HTMLImageElement | null ?? undefined;
}
