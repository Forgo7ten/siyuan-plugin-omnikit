<script lang="ts">
  import { onMount, untrack } from "svelte";
  import { describeError } from "../../../core/host/describeError.ts";
  import type { FeaturePhase } from "../../../core/framework/BaseFeature.ts";
  import type { JsonStore } from "../../../core/store/JsonStore.ts";
  import { SettingsConflictError, isSettingsConflictError } from "../../../core/store/SettingsConflictError.ts";
  import { defaultTitledLinkConfig, parseTitledLinkConfig } from "../policy/settings.ts";
  import type { TitledLinkConfig } from "../policy/types.ts";

  interface Props {
    store: JsonStore<TitledLinkConfig>;
    runtimePhase: FeaturePhase | "configured";
    t: (key: string, values?: Record<string, string | number>) => string;
  }

  let { store, runtimePhase, t }: Props = $props();
  const copy = (value: TitledLinkConfig): TitledLinkConfig => structuredClone(value);
  const same = (left: unknown, right: unknown): boolean => JSON.stringify(left) === JSON.stringify(right);
  const initial = untrack(() => store.snapshot());
  let baseline = $state(copy(initial));
  let draft = $state(copy(initial));
  let busy = $state(false);
  let conflict = $state(false);
  let readOnly = $state(untrack(() => store.needsRecovery));
  let error = $state("");
  let notice = $state("");
  let dirty = $derived(!same(draft, baseline));

  function adopt(value: Readonly<TitledLinkConfig>): void {
    const next = copy(value as TitledLinkConfig);
    baseline = next;
    draft = copy(next);
    conflict = false;
    error = "";
    notice = "";
  }

  onMount(() => store.subscribe(value => {
    readOnly = store.needsRecovery;
    if (!dirty) adopt(value);
    else if (!same(value, baseline)) conflict = true;
  }));

  function resetDraft(): void {
    draft = defaultTitledLinkConfig();
    error = "";
    notice = "";
  }

  async function save(event: SubmitEvent): Promise<void> {
    event.preventDefault();
    if (busy || readOnly || conflict || !dirty) return;
    busy = true;
    error = "";
    notice = "";
    try {
      const next = parseTitledLinkConfig($state.snapshot(draft));
      const expected = $state.snapshot(baseline);
      await store.update(current => {
        if (!same(current, expected)) throw new SettingsConflictError(t("settings.concurrentChange"));
        Object.assign(current, next);
      });
      adopt(store.snapshot());
      notice = t("settings.saved");
    } catch (cause) {
      error = describeError(cause);
      if (isSettingsConflictError(cause)) conflict = true;
    } finally {
      busy = false;
    }
  }

  async function recoverSettings(): Promise<void> {
    busy = true;
    error = "";
    try {
      await store.recoverWithBackup();
      readOnly = false;
      adopt(store.snapshot());
      notice = t("recovery.settingsOk");
    } catch (cause) {
      error = `${t("recovery.settingsFailed")} ${describeError(cause)}`;
    } finally {
      busy = false;
    }
  }
</script>

<form class="omnikit-titled-link-settings" onsubmit={save}>
  {#if readOnly}
    <div class="notice notice--error" role="alert">
      <strong>{t("recovery.settingsWarning")}</strong>
      <button type="button" class="b3-button b3-button--outline" disabled={busy} onclick={recoverSettings}>
        {t("recovery.settingsButton")}
      </button>
    </div>
  {/if}
  {#if runtimePhase !== "enabled" && runtimePhase !== "configured"}<div class="notice">{t("settings.disabledButEditable")}</div>{/if}

  <fieldset disabled={busy || readOnly}>
    <label class="setting-row">
      <span><strong>{t("feature.titledLink.settings.auto")}</strong><small>{t("feature.titledLink.settings.autoHelp")}</small></span>
      <input type="checkbox" class="b3-switch" bind:checked={draft.auto.enabled} />
    </label>
    <label class="setting-row">
      <span><strong>{t("feature.titledLink.settings.replaceTitle")}</strong><small>{t("feature.titledLink.settings.replaceTitleHelp")}</small></span>
      <input type="checkbox" class="b3-switch" bind:checked={draft.replaceTitle} />
    </label>
    <label class="setting-row">
      <span><strong>{t("feature.titledLink.settings.fallbackToHostname")}</strong><small>{t("feature.titledLink.settings.fallbackToHostnameHelp")}</small></span>
      <input type="checkbox" class="b3-switch" bind:checked={draft.fallbackToHostname} />
    </label>
  </fieldset>

  {#if conflict}
    <div class="notice notice--error" role="alert">
      {t("settings.concurrentChange")}
      <button type="button" class="b3-button b3-button--outline" onclick={() => adopt(store.snapshot())}>
        {t("settings.discardReload")}
      </button>
    </div>
  {/if}
  {#if error}<p class="warning" role="alert">{error}</p>{/if}
  {#if notice}<p class="notice" role="status">{notice}</p>{/if}

  <footer class="save-bar">
    <button type="button" class="b3-button b3-button--outline" disabled={busy || readOnly} onclick={resetDraft}>
      {t("settings.resetDraft")}
    </button>
    <button type="submit" class="b3-button b3-button--primary" disabled={busy || readOnly || conflict || !dirty}>
      {busy ? t("settings.saving") : t("settings.save")}
    </button>
  </footer>
</form>

<style lang="scss">
  .omnikit-titled-link-settings, fieldset { display: grid; gap: 0.75rem; }
  fieldset { border: 0; margin: 0; padding: 0; }
  .setting-row { display: flex; align-items: center; justify-content: space-between; gap: 1rem; }
  .setting-row > span:first-child { display: grid; gap: 0.2rem; }
  small { color: var(--b3-theme-on-surface-light); }
  .save-bar { display: flex; justify-content: flex-end; gap: 0.5rem; }
  .notice { color: var(--b3-theme-on-surface-light); }
  .notice--error, .warning { color: var(--b3-theme-error); }
</style>

