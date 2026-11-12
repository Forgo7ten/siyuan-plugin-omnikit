import imageCompression from "browser-image-compression";
import { getFrontend } from "siyuan";
import type { FeatureContext } from "../../core/FeatureContext.ts";
import type { FeatureScope } from "../../core/FeatureScope.ts";
import { KernelClient } from "../../core/KernelClient.ts";
import { isMobileFrontend } from "../../core/Platform.ts";
import { createImageUI } from "./ImageTaskUI.ts";
import { AssetStore, SingleOriginalFinalizer } from "./assets.ts";
import { createDesktopBridge } from "./desktop.ts";
import { SourceReader } from "./download.ts";
import { BicEncoder } from "./image.ts";
import type { ImageProcessingServices } from "./ImageProcessingServices.ts";
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
  return {
    kernel,
    reader,
    encoder,
    assets: new AssetStore(kernel, origin),
    references: new ReferenceService(kernel, origin),
    finalizer: new SingleOriginalFinalizer(kernel, context.compatibility.version),
    ui,
    origin,
    mobile,
    desktopFiles: Boolean(desktop),
    config: () => context.settings.getFeature<ImageConfig>("imageCompressor"),
  };
}
