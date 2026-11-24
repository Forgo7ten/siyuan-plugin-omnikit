import type { FeatureContext } from "../../../core/framework/FeatureContext.ts";
import type { FeatureScope } from "../../../core/framework/FeatureScope.ts";
import { KernelClient } from "../../../core/host/KernelClient.ts";
import { getCurrentFrontend, isMobileFrontend } from "../../../core/host/Platform.ts";
import { translate } from "../../../i18n/translate.ts";
import { createImageUI } from "../ui/ImageTaskUI.ts";
import { AssetStore } from "./assets.ts";
import { createDesktopBridge } from "./desktop.ts";
import { SourceReader } from "./download.ts";
import { CanvasWebpEncoder, probeSmartCompressionSupport } from "./image.ts";
import { AdaptiveImageCompressor } from "../similarity/AdaptiveImageCompressor.ts";
import { compressOccurrence, savePreview, type ImageProcessingServices } from "./ImageProcessingServices.ts";
import { imageRecordsFor } from "../store/ImageCompressionRecordStore.ts";
import type { ImageConfig } from "../policy/parseImageConfig.ts";
import { ReferenceService } from "./references.ts";

export function createImageServices(context: FeatureContext, scope: FeatureScope): ImageProcessingServices {
  const origin = location.origin;
  const mobile = isMobileFrontend();
  const t = (key: string, values?: Record<string, string | number>) =>
    translate(context.plugin.i18n as Record<string, unknown>, key, values);
  const ui = createImageUI(scope, t, context.feedback);
  const frontend = getCurrentFrontend();
  const nodeRequire = (globalThis as typeof globalThis & { require?: (name: string) => any }).require;
  const desktop = (frontend === "desktop" || frontend === "desktop-window") && nodeRequire
    ? createDesktopBridge(nodeRequire)
    : undefined;
  const kernel = new KernelClient();
  const reader = new SourceReader(fetch, desktop);
  const baseCodec = new CanvasWebpEncoder();
  const encoder = new AdaptiveImageCompressor(baseCodec);
  void probeSmartCompressionSupport().catch(() => undefined);
  const { store: records, ready: recordsReady } = imageRecordsFor(context.plugin);
  return {
    kernel,
    reader,
    encoder,
    assets: new AssetStore(kernel, origin),
    references: new ReferenceService(kernel, origin),
    records,
    recordsReady,
    logger: context.logger,
    compressOccurrence(target, config, signal, options) {
      return compressOccurrence(this, target, config, signal, options);
    },
    savePreview(target, encodedFile, signal, replace, metrics) {
      return savePreview(this, target, encodedFile, signal, replace, metrics);
    },
    ui,
    origin,
    mobile,
    userAgent: () => context.settings.getUserAgent(),
    config: () => context.settings.getFeature<ImageConfig>("imageCompressor"),
  };
}
