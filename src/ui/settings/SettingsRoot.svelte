<script lang="ts">
  import { onMount, untrack } from "svelte";
  import type { FeatureRegistration } from "../../core/FeatureRegistration.ts";
  import type { SettingsManager, CoreSettings } from "../../core/SettingsManager.ts";
  import type { FeatureManager } from "../../core/FeatureManager.ts";
  import type { FeatureStatus } from "../../core/FeatureManager.ts";

  interface Props {
    registrations: readonly FeatureRegistration<any>[];
    settings: SettingsManager;
    manager?: FeatureManager;
    t: (key: string) => string;
  }
  let { registrations, settings, manager, t }: Props = $props();
  let core = $state<CoreSettings>(untrack(() => settings.core.snapshot()));
  let coreRecovery = $state(untrack(() => settings.core.needsRecovery));
  let featureRecovery = $state<Record<string, boolean>>({});
  let activeId = $state("general");
  let busy = $state(false);
  let error = $state("");
  let runtimeStatuses = $state<FeatureStatus[]>(untrack(() => manager?.statuses() ?? []));

  onMount(() => {
    const disposeCore = settings.core.subscribe(value => {
      core = value as CoreSettings;
      coreRecovery = settings.core.needsRecovery;
    });
    const disposeFeatures = registrations.map(entry => {
      const store = settings.store(entry.id);
      return store.subscribe(() => { featureRecovery[entry.id] = store.needsRecovery; });
    });
    const disposeStatus = manager?.subscribeStatus(statuses => { runtimeStatuses = statuses; });
    return () => { disposeCore(); disposeFeatures.forEach(dispose => dispose()); disposeStatus?.(); };
  });

  async function changeDebugLog(enabled: boolean) {
    if (busy) return;
    busy = true;
    error = "";
    try {
      await settings.updateGeneral({ debugLog: enabled });
      core = settings.core.snapshot();
    } catch (cause) { error = String(cause); }
    finally { busy = false; }
  }

  async function recoverCore() {
    if (busy) return;
    busy = true;
    error = "";
    try {
      await settings.core.recoverWithBackup();
      core = settings.core.snapshot();
    } catch (cause) { error = String(cause); }
    finally { busy = false; }
  }

  async function toggle(id: string, enabled: boolean) {
    if (busy) return;
    busy = true;
    error = "";
    try {
      const ok = manager
        ? await manager.setEnabled(id, enabled)
        : (await settings.setFeatureEnabled(id, enabled), true);
      if (!ok) throw new Error(t("toggleFailed"));
      core = settings.core.snapshot();
    } catch (cause) { error = String(cause); }
    finally { busy = false; }
  }

  async function retry(id: string) {
    if (busy || !manager) return;
    busy = true;
    error = "";
    try {
      const ok = await manager.setEnabled(id, true);
      if (!ok) throw new Error(t("toggleFailed"));
    } catch (cause) { error = String(cause); }
    finally { busy = false; }
  }
</script>

<div class="omnikit-settings-root fn__flex">
  <aside class="b3-list b3-list--background omnikit-tabs" aria-label="OmniKit">
    <button class:b3-list-item--focus={activeId === "general"}
      class="b3-list-item" onclick={() => activeId = "general"}>
      {t("general.title")}
    </button>
    {#each registrations as entry (entry.id)}
      <button class:b3-list-item--focus={activeId === entry.id}
        class="b3-list-item" onclick={() => activeId = entry.id}>
        {t(entry.titleKey)}
      </button>
    {/each}
  </aside>
  <main class="fn__flex-1 omnikit-settings-panel">
    {#if activeId === "general"}
      {#if coreRecovery}
        <p class="omnikit-error" role="alert">{settings.core.error}</p>
        <button class="b3-button" disabled={busy} onclick={recoverCore}>
          {t("recovery.settingsButton")}
        </button>
      {/if}
      <h2>{t("general.title")}</h2>
      <label class="b3-label">
        <span>{t("general.debugLog")}</span>
        <input class="b3-switch" type="checkbox" checked={core.general.debugLog}
          disabled={busy || coreRecovery}
          onchange={e => changeDebugLog(e.currentTarget.checked)} />
      </label>
    {:else}
      {#each registrations.filter(r => r.id === activeId) as entry (entry.id)}
        {@const View = entry.settingsView}
        <!-- @invariant Bind display state to core store changes, not a non-reactive getter. -->
        <!-- @invariant Use the runtime's recovery-aware switch state when feature data is corrupt. -->
        {@const needsFeatureRecovery = featureRecovery[entry.id] ?? settings.store(entry.id).needsRecovery}
        {@const enabled = core.featureStates[entry.id]?.enabled ?? entry.defaultEnabled}
        {@const runtime = runtimeStatuses.find(status => status.id === entry.id)}
        <header class="omnikit-feature-header fn__flex">
          <span class="fn__flex-1">
            <h2>{t(entry.titleKey)}</h2>
            <p>{t(entry.descriptionKey)}</p>
          </span>
          <label class="omnikit-feature-toggle">
            {t("feature.enabled")}
            <input class="b3-switch" type="checkbox" checked={enabled}
              disabled={busy || coreRecovery || needsFeatureRecovery}
              onchange={e => toggle(entry.id, e.currentTarget.checked)} />
          </label>
        </header>
        {#if manager}
          <p>{t(`runtime.${runtime?.status ?? "disabled"}`)}</p>
          {#if runtime?.status === "error" && runtime.error}
            <p class="omnikit-error" role="alert">{runtime.error}</p>
          {/if}
          {#if enabled && (runtime?.status === "error" || runtime?.status === "disabled")}
            <button class="b3-button" disabled={busy || coreRecovery || needsFeatureRecovery} onclick={() => retry(entry.id)}>{t("runtime.retry")}</button>
          {/if}
        {:else}
          <p>{t("runtime.unavailable")}</p>
        {/if}
        <View store={settings.store(entry.id)} disabled={!enabled || coreRecovery || needsFeatureRecovery} {t} />
      {/each}
    {/if}
    {#if error}<p class="omnikit-error" role="alert">{error}</p>{/if}
  </main>
</div>

<style lang="scss">
  .omnikit-settings-root { width: 100%; height: 100%; min-height: 0; }
  .omnikit-tabs { width: 10rem; overflow-y: auto; flex: 0 0 10rem; }
  .omnikit-tabs button { width: 100%; text-align: left; }
  .omnikit-settings-panel { padding: 1rem; overflow: auto; min-width: 0; }
  .omnikit-feature-header { gap: 1rem; align-items: center; }
  .omnikit-feature-toggle { white-space: nowrap; display: flex; gap: .5rem; align-items: center; }
  .omnikit-error { color: var(--b3-theme-error); }
  @media(max-width: 600px) {
    .omnikit-settings-root { flex-direction: column; }
    .omnikit-tabs { width: 100%; flex: 0 0 auto; display: flex; max-height: 3rem; overflow-x: auto; }
    .omnikit-tabs button { flex: 0 0 auto; width: auto; }
  }
</style>
