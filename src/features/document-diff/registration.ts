import { defineFeature, featureConfigFile } from "../../core/framework/FeatureRegistration.ts";
import { KernelClient } from "../../core/host/KernelClient.ts";
import { DOCUMENT_DIFF_FRONTENDS, DocumentDiffFeature } from "./DocumentDiffFeature.ts";
import { defaultHostBridge } from "./host/SiyuanBridge.ts";
import { documentDiffSettingsCodec, type DocumentDiffConfig } from "./model/settings.ts";
import DocumentDiffSettingsPanel from "./ui/DocumentDiffSettingsPanel.svelte";
import { mountDiffToolbar } from "./ui/mountDiffToolbar.ts";

export const documentDiffRegistration = defineFeature<DocumentDiffConfig>({
  id: DocumentDiffFeature.ID,
  titleKey: "feature.documentDiff.title",
  descriptionKey: "feature.documentDiff.description",
  defaultEnabled: true,
  frontends: DOCUMENT_DIFF_FRONTENDS,
  file: featureConfigFile(DocumentDiffFeature.ID),
  codec: documentDiffSettingsCodec,
  create: (plugin, settings) =>
    new DocumentDiffFeature(plugin, settings, {
      bridge: defaultHostBridge,
      mountToolbar: mountDiffToolbar,
      kernel: new KernelClient(),
    }),
  settingsView: DocumentDiffSettingsPanel,
});
