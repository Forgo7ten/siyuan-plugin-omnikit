<script lang="ts">
  import { onMount } from "svelte";
  import { getFrontend } from "siyuan";
  import type { JsonStore } from "../../core/JsonStore.ts";
  import { KernelClient } from "../../core/KernelClient.ts";
  import type { ImageFeatureConfig } from "./parseImageConfig.ts";
  import ImageSettingsPanel from "./ImageSettingsPanel.svelte";

  interface Props {
    store: JsonStore<ImageFeatureConfig>;
    runtimePhase: string;
    t: (key: string) => string;
  }
  let { store, runtimePhase, t }: Props = $props();
  let hostVersion = $state("unknown");
  let desktopFrontend = $state(false);
  const kernel = new KernelClient();

  onMount(() => {
    const controller = new AbortController();
    const frontend = getFrontend();
    desktopFrontend = frontend === "desktop" || frontend === "desktop-window" || frontend === "browser-desktop";
    void kernel.post<unknown>("/api/system/version", {}, { signal: controller.signal })
      .then(response => {
        if (typeof response.data === "string") hostVersion = response.data;
      })
      .catch(() => undefined);
    return () => controller.abort();
  });

  async function validateDocument(rootID: string): Promise<{ id: string; title: string }> {
    if (!/^\d{14}-[a-z0-9]{7}$/.test(rootID)) throw new Error(t("settings.invalidDocument"));
    const response = await kernel.post<unknown>("/api/query/sql", {
      stmt: `SELECT id, root_id, content FROM blocks WHERE id = '${rootID}' AND type = 'd' LIMIT 1`,
      mode: "readonly",
    });
    const rows = response.data;
    if (!Array.isArray(rows) || rows.length !== 1 || !rows[0] || typeof rows[0] !== "object") {
      throw new Error(t("settings.invalidDocument"));
    }
    const row = rows[0] as { id?: unknown; root_id?: unknown; content?: unknown };
    if (row.id !== rootID || row.root_id !== rootID || typeof row.content !== "string") {
      throw new Error(t("settings.invalidDocument"));
    }
    return { id: rootID, title: row.content.slice(0, 512) };
  }
</script>

<!-- Feature-owned entry point keeps settings available independently of runtime activation. -->
<ImageSettingsPanel {store} {runtimePhase} {hostVersion} {desktopFrontend} {validateDocument} {t} />
