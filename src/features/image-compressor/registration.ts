import { defineFeature } from "../../core/FeatureRegistration.ts";
import { ImageCompressorFeature } from "./ImageCompressorFeature.ts";
import ImageSettingsPanel from "./ImageSettingsPanel.svelte";
import { defaultImageFeatureConfig, parseImageConfig, type ImageFeatureConfig } from "./parseImageConfig.ts";
export type { ImageFeatureConfig, PagePermission } from "./parseImageConfig.ts";

/** No reference to the core settings schema; schema v1 legacy fields are read compatibly. */
export const imageCompressorRegistration = defineFeature<ImageFeatureConfig>({
  id: "imageCompressor",
  titleKey: "feature.imageCompressor.title",
  descriptionKey: "feature.imageCompressor.description",
  defaultEnabled: true,
  file: "feature-image-compressor.json",
  codec: { defaults: defaultImageFeatureConfig, parse: parseImageConfig },
  create: (plugin, settings) => new ImageCompressorFeature(plugin, settings),
  settingsView: ImageSettingsPanel,
});
