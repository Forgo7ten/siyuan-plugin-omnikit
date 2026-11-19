import { defineFeature, featureConfigFile } from "../../core/framework/FeatureRegistration.ts";
import { ImageCompressorFeature } from "./ImageCompressorFeature.ts";
import { reloadLoadedImageRecords } from "./store/ImageCompressionRecordStore.ts";
import ImageRecordsDock from "./ui/ImageRecordsDock.svelte";
import ImageSettingsBridge from "./ui/ImageSettingsBridge.svelte";
import { defaultImageFeatureConfig, parseImageConfig, type ImageFeatureConfig } from "./policy/parseImageConfig.ts";
export type { ImageFeatureConfig, PagePermission } from "./policy/parseImageConfig.ts";

export const imageCompressorRegistration = defineFeature<ImageFeatureConfig>({
  id: "imageCompressor",
  titleKey: "feature.imageCompressor.title",
  descriptionKey: "feature.imageCompressor.description",
  defaultEnabled: false,
  frontends: ["all"],
  file: featureConfigFile("imageCompressor"),
  codec: { defaults: defaultImageFeatureConfig, parse: parseImageConfig },
  create: (plugin, settings) => new ImageCompressorFeature(plugin, settings),
  settingsView: ImageSettingsBridge,
  dockView: ImageRecordsDock,
  reloadData: plugin => reloadLoadedImageRecords(plugin),
});
