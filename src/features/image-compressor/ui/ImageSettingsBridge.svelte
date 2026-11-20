<script lang="ts">
  import { onMount } from "svelte";
  import type { JsonStore } from "../../../core/store/JsonStore.ts";
  import { KernelClient } from "../../../core/host/KernelClient.ts";
  import { getCurrentFrontend } from "../../../core/host/Platform.ts";
  import { isDocumentRootIdentity } from "../policy/DocumentIdentity.ts";
  import { NODE_ID, type ImageFeatureConfig } from "../policy/parseImageConfig.ts";
  import { resolveDocumentTitle } from "../services/documentTitle.ts";
  import ImageSettingsPanel from "./ImageSettingsPanel.svelte";

  interface Props {
    store: JsonStore<ImageFeatureConfig>;
    runtimePhase: string;
    t: (key: string, values?: Record<string, string | number>) => string;
  }
  let { store, runtimePhase, t }: Props = $props();
  let hostVersion = $state("unknown");
  let desktopFrontend = $state(false);
  const kernel = new KernelClient();

  onMount(() => {
    const controller = new AbortController();
    const frontend = getCurrentFrontend();
    desktopFrontend = frontend === "desktop" || frontend === "desktop-window" || frontend === "browser-desktop";
    void kernel.post<unknown>("/api/system/version", {}, { signal: controller.signal })
      .then(response => {
        if (typeof response.data === "string") hostVersion = response.data;
      })
      .catch(() => undefined);
    return () => controller.abort();
  });

  async function validateDocument(rootID: string): Promise<{ id: string; title: string }> {
    if (!NODE_ID.test(rootID)) throw new Error(t("settings.invalidDocument"));
    const infoResponse = await kernel.post<{
      id?: string;
      rootID?: string;
      type?: string;
      box?: string;
      rootTitle?: string;
    }>("/api/block/getBlockInfo", { id: rootID });
    const info = infoResponse.data;
    if (!isDocumentRootIdentity(info, rootID)) {
      throw new Error(t("settings.invalidDocument"));
    }
    const title = await resolveDocumentTitle(kernel, rootID, { fallbackRootTitle: info?.rootTitle });
    return { id: rootID, title };
  }
</script>

<!-- Feature-owned entry point keeps settings available independently of runtime activation. -->
<ImageSettingsPanel {store} {runtimePhase} {hostVersion} {desktopFrontend} {validateDocument} {t} />
