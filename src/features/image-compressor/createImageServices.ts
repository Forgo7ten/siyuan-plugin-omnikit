import imageCompression from "browser-image-compression";
import { getFrontend } from "siyuan";
import type { FeatureContext } from "../../core/FeatureContext.ts";
import type { FeatureScope } from "../../core/FeatureScope.ts";
import { KernelClient } from "../../core/KernelClient.ts";
import { isMobileFrontend } from "../../core/Platform.ts";
import { createImageUI } from "./ImageTaskUI.ts";
import { AssetStore } from "./assets.ts";
import { createDesktopBridge } from "./desktop.ts";
import { SourceReader } from "./download.ts";
import { BicEncoder } from "./image.ts";
import { compressOccurrence, savePreview, type ImageProcessingServices } from "./ImageProcessingServices.ts";
import { imageRecordsFor } from "./ImageCompressionRecordStore.ts";
import type { ImageConfig } from "./parseImageConfig.ts";
import { ReferenceService } from "./references.ts";

export function createImageServices(context: FeatureContext, scope: FeatureScope): ImageProcessingServices {
  const origin = location.origin;
  const mobile = isMobileFrontend();
  const t = (key: string) => String((context.plugin.i18n as Record<string, string>)[key] ?? key);
  const ui = createImageUI(scope, t);
  const frontend = getFrontend();
  const nodeRequire = (globalThis as typeof globalThis & { require?: (name: string) => any }).require;
  const desktop = (frontend === "desktop" || frontend === "desktop-window") && nodeRequire
    ? createDesktopBridge(nodeRequire, path => ui.confirm(t("sources.localPermission"), path, scope.signal))
    : undefined;
  const kernel = new KernelClient();
  const reader = new SourceReader(fetch, desktop);
  const libraryURL = new URL(`/plugins/${encodeURIComponent(context.plugin.name)}/browser-image-compression.js`, origin).href;
  const encoder = new BicEncoder(imageCompression, libraryURL);
  const { store: records, ready: recordsReady } = imageRecordsFor(context.plugin);
  return {
    kernel,
    reader,
    encoder,
    assets: new AssetStore(kernel, origin),
    references: new ReferenceService(kernel, origin),
    records,
    recordsReady,
    compressOccurrence(target, config, signal, options) {
      return compressOccurrence(this, target, config, signal, options);
    },
    savePreview(target, encodedFile, signal, replace) {
      return savePreview(this, target, encodedFile, signal, replace);
    },
    ui,
    origin,
    mobile,
    desktopFiles: Boolean(desktop),
    config: () => context.settings.getFeature<ImageConfig>("imageCompressor"),
  };
}
