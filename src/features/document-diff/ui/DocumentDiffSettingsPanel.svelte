<script lang="ts">
  import { onMount, untrack } from "svelte";
  import type { FeaturePhase } from "../../../core/framework/BaseFeature.ts";
  import { describeError } from "../../../core/host/describeError.ts";
  import type { JsonStore } from "../../../core/store/JsonStore.ts";
  import { SettingsConflictError, isSettingsConflictError } from "../../../core/store/SettingsConflictError.ts";
  import type { RegisterDraftParticipant } from "../../../ui/settings/DraftParticipant.ts";
  import {
    defaultDocumentDiffConfig,
    parseDocumentDiffConfig,
    type DocumentDiffConfig,
  } from "../model/settings.ts";

  interface Props {
    store: JsonStore<DocumentDiffConfig>;
    runtimePhase: FeaturePhase | "configured";
    t: (key: string, values?: Record<string, string | number>) => string;
    registerDraft?: RegisterDraftParticipant;
    globalSaving?: boolean;
  }

  let { store, runtimePhase, t, registerDraft, globalSaving = false }: Props = $props();
  const copy = (value: DocumentDiffConfig): DocumentDiffConfig => structuredClone(value);
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

  function adopt(value: Readonly<DocumentDiffConfig>): void {
    const next = copy(value as DocumentDiffConfig);
    baseline = next;
    draft = copy(next);
    conflict = false;
    error = "";
    notice = "";
  }

  function validateDraft(): void {
    parseDocumentDiffConfig($state.snapshot(draft));
  }

  function resetDraft(): void {
    draft = defaultDocumentDiffConfig();
    error = "";
    notice = "";
  }

  async function saveDraft(): Promise<void> {
    if (readOnly || conflict || !dirty) return;
    error = "";
    notice = "";
    try {
      const next = parseDocumentDiffConfig($state.snapshot(draft));
      const expected = copy($state.snapshot(baseline));
      await store.update(current => {
        if (!same(current, expected)) {
          throw new SettingsConflictError(t("settings.concurrentChange"));
        }
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
      id: "document-diff",
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

<div class="omnikit-document-diff-settings">
  {#if readOnly}
    <div class="notice notice--error" role="alert">
      <strong>{t("recovery.settingsWarning")}</strong>
      <button
        type="button"
        class="b3-button b3-button--outline"
        disabled={busy || globalSaving}
        onclick={recoverSettings}
      >
        {t("recovery.settingsButton")}
      </button>
    </div>
  {/if}
  {#if runtimePhase !== "enabled" && runtimePhase !== "configured"}
    <div class="notice">{t("settings.disabledButEditable")}</div>
  {/if}
  {#if conflict}
    <div class="notice notice--error" role="alert">
      <span>{t("settings.concurrentChange")}</span>
      <button
        type="button"
        class="b3-button b3-button--outline"
        disabled={busy || globalSaving}
        onclick={() => adopt(store.snapshot())}
      >
        {t("settings.discardReload")}
      </button>
    </div>
  {/if}

  <label class="row">
    <div>
      <strong>{t("feature.documentDiff.settings.defaultSyncScroll")}</strong>
      <div class="b3-label__text">{t("feature.documentDiff.settings.defaultSyncScrollHelp")}</div>
    </div>
    <input
      class="b3-switch"
      type="checkbox"
      bind:checked={draft.defaultSyncScroll}
      disabled={readOnly || busy || globalSaving}
    />
  </label>

  {#if error}<div class="notice notice--error" role="alert">{error}</div>{/if}
  {#if notice}<div class="notice">{notice}</div>{/if}
</div>

<style lang="scss">
  .omnikit-document-diff-settings {
    display: grid;
    gap: 10px;
  }

  .row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
  }

  .notice {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
    padding: 8px 10px;
    border: 1px solid var(--b3-border-color);
    border-radius: 4px;
    background: var(--b3-theme-surface);
  }

  .notice--error {
    color: var(--b3-theme-error);
  }
</style>
