<script lang="ts">
  import { onMount, untrack } from "svelte";
  import { describeError } from "../../../core/host/describeError.ts";
  import type { FeaturePhase } from "../../../core/framework/BaseFeature.ts";
  import type { JsonStore } from "../../../core/store/JsonStore.ts";
  import { SettingsConflictError, isSettingsConflictError } from "../../../core/store/SettingsConflictError.ts";
  import type { RegisterDraftParticipant } from "../../../ui/settings/DraftParticipant.ts";
  import { defaultTitledLinkConfig, parseTitledLinkConfig } from "../policy/settings.ts";
  import type { TitledLinkConfig } from "../policy/types.ts";
  import { resolveAutoPasteHelp } from "./autoPasteHelp.ts";

  interface Props {
    store: JsonStore<TitledLinkConfig>;
    runtimePhase: FeaturePhase | "configured";
    t: (key: string, values?: Record<string, string | number>) => string;
    registerDraft?: RegisterDraftParticipant;
    globalSaving?: boolean;
  }

  let { store, runtimePhase, t, registerDraft, globalSaving = false }: Props = $props();
  const copy = (value: TitledLinkConfig): TitledLinkConfig => structuredClone(value);
  const same = (left: unknown, right: unknown): boolean => JSON.stringify(left) === JSON.stringify(right);
  const initial = untrack(() => copy(store.snapshot()));
  let baseline = $state(copy(initial));
  let draft = $state(copy(initial));
  let busy = $state(false);
  let conflict = $state(false);
  let readOnly = $state(untrack(() => store.needsRecovery));
  let error = $state("");
  let notice = $state("");
  let dirty = $derived(!same($state.snapshot(draft), $state.snapshot(baseline)));
  let autoPasteHelpText = $derived(resolveAutoPasteHelp(t));

  function adopt(value: Readonly<TitledLinkConfig>): void {
    const next = copy(value as TitledLinkConfig);
    baseline = next;
    draft = copy(next);
    conflict = false;
    error = "";
    notice = "";
  }

  function validateDraft(): void {
    parseTitledLinkConfig($state.snapshot(draft));
  }

  function resetDraft(): void {
    draft = defaultTitledLinkConfig();
    error = "";
    notice = "";
  }

  async function saveDraft(): Promise<void> {
    if (readOnly || conflict || !dirty) return;
    error = "";
    notice = "";
    try {
      const next = parseTitledLinkConfig($state.snapshot(draft));
      const expected = copy($state.snapshot(baseline));
      await store.update(current => {
        if (!same(current, expected)) throw new SettingsConflictError(t("settings.concurrentChange"));
        Object.assign(current, next);
      });
      adopt(store.snapshot());
    } catch (cause) {
      error = describeError(cause);
      if (isSettingsConflictError(cause)) conflict = true;
      throw cause;
    }
  }

  onMount(() => {
    const unsubscribe = store.subscribe(value => {
      readOnly = store.needsRecovery;
      if (!dirty) adopt(value);
      else if (!same(value, $state.snapshot(baseline))) conflict = true;
    });
    const unregister = registerDraft?.({
      id: "titled-link",
      isDirty: () => dirty,
      validate: validateDraft,
      save: saveDraft,
      resetToDefaults: resetDraft,
      isReadOnly: () => readOnly,
      hasConflict: () => conflict,
    });
    return () => {
      unregister?.();
      unsubscribe();
    };
  });

  async function recoverSettings(): Promise<void> {
    if (busy || globalSaving) return;
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

<div class="omnikit-titled-link-settings">
  {#if readOnly}
    <div class="notice notice--error" role="alert">
      <strong>{t("recovery.settingsWarning")}</strong>
      <button type="button" class="b3-button b3-button--outline" disabled={busy || globalSaving} onclick={recoverSettings}>
        {t("recovery.settingsButton")}
      </button>
    </div>
  {/if}
  {#if runtimePhase !== "enabled" && runtimePhase !== "configured"}<div class="notice">{t("settings.disabledButEditable")}</div>{/if}

  <fieldset disabled={busy || globalSaving || readOnly}>
    <label class="setting-row">
      <span><strong>{t("feature.titledLink.settings.auto")}</strong><small>{autoPasteHelpText}</small></span>
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
      <button type="button" class="b3-button b3-button--outline" disabled={busy || globalSaving} onclick={() => adopt(store.snapshot())}>
        {t("settings.discardReload")}
      </button>
    </div>
  {/if}
  {#if error}<p class="warning" role="alert">{error}</p>{/if}
  {#if notice}<p class="notice" role="status">{notice}</p>{/if}
</div>

<style lang="scss">
  .omnikit-titled-link-settings, fieldset { display: grid; gap: 0.75rem; }
  fieldset { border: 0; margin: 0; padding: 0; }
  .setting-row { display: flex; align-items: center; justify-content: space-between; gap: 1rem; }
  .setting-row > span:first-child { display: grid; gap: 0.2rem; }
  small { color: var(--b3-theme-on-surface-light); }
  .notice { color: var(--b3-theme-on-surface-light); }
  .notice--error, .warning { color: var(--b3-theme-error); }
</style>
