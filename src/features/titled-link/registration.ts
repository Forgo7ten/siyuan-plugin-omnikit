import { defineFeature, featureConfigFile } from "../../core/framework/FeatureRegistration.ts";
import { TitledLinkFeature } from "./TitledLinkFeature.ts";
import TitledLinkSettingsPanel from "./ui/TitledLinkSettingsPanel.svelte";
import { titledLinkSettingsCodec } from "./policy/settings.ts";
import type { TitledLinkConfig } from "./policy/types.ts";

export const titledLinkRegistration = defineFeature<TitledLinkConfig>({
  id: "titled-link",
  titleKey: "feature.titledLink.title",
  descriptionKey: "feature.titledLink.description",
  defaultEnabled: true,
  frontends: ["all"],
  file: featureConfigFile("titled-link"),
  codec: titledLinkSettingsCodec,
  create: (plugin, settings) => new TitledLinkFeature(plugin, settings),
  settingsView: TitledLinkSettingsPanel,
});
