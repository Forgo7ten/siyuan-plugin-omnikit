import { defineFeature, featureConfigFile } from "../../core/FeatureRegistration.ts";
import { ImageCompressorFeature } from "./ImageCompressorFeature.ts";
import ImageSettingsBridge from "./ImageSettingsBridge.svelte";
import { defaultImageFeatureConfig, parseImageConfig, type ImageFeatureConfig } from "./parseImageConfig.ts";
export type { ImageFeatureConfig, PagePermission } from "./parseImageConfig.ts";

export const imageCompressorRegistration = defineFeature<ImageFeatureConfig>({
  id: "imageCompressor",
  titleKey: "feature.imageCompressor.title",
  descriptionKey: "feature.imageCompressor.description",
  defaultEnabled: true,
  file: featureConfigFile("imageCompressor"),
  codec: { defaults: defaultImageFeatureConfig, parse: parseImageConfig },
  create: (plugin, settings) => new ImageCompressorFeature(plugin, settings),
  settingsView: ImageSettingsBridge,
});
