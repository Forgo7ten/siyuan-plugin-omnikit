<script lang="ts">
  import type { GeneralSettings } from "../../core/store/SettingsManager.ts";

  interface Props {
    sectionRef: (el: HTMLElement | undefined) => void;
    generalDraft: GeneralSettings;
    coreRecovery: boolean;
    coreError?: string;
    coreConflict: boolean;
    globalSaving: boolean;
    t: (key: string, values?: Record<string, string | number>) => string;
    onUpdateDebugLog: (checked: boolean) => void;
    onUpdateUserAgent: (value: string) => void;
    onRecover: () => void;
    onDiscardReload: () => void;
  }

  let {
    sectionRef,
    generalDraft,
    coreRecovery,
    coreError,
    coreConflict,
    globalSaving,
    t,
    onUpdateDebugLog,
    onUpdateUserAgent,
    onRecover,
    onDiscardReload,
  }: Props = $props();

  function bindSection(node: HTMLElement) {
    sectionRef(node);
    return {
      destroy() {
        sectionRef(undefined);
      },
    };
  }
</script>

<section
  id="section-general"
  class="feature-card"
  use:bindSection>
  <header class="card-header">
    <div class="card-title-group">
      <h2 class="card-title">{t("general.title")}</h2>
      <p class="card-desc">{t("general.description")}</p>
    </div>
  </header>

  <div class="card-body">
    {#if coreRecovery}
      <div class="recovery-box">
        <p class="setting-hint">{t("recovery.settingsWarning")}</p>
        <p class="omnikit-error" role="alert">{coreError}</p>
        <button class="b3-button b3-button--cancel" disabled={globalSaving} onclick={onRecover}>
          {t("recovery.settingsButton")}
        </button>
      </div>
    {/if}

    <div class="setting-row">
      <div class="setting-info">
        <span class="setting-title">{t("general.debugLog")}</span>
        <span class="setting-hint">{t("general.debugLogNote")}</span>
      </div>
      <input
        class="b3-switch"
        type="checkbox"
        checked={generalDraft.debugLog}
        disabled={globalSaving || coreRecovery}
        onchange={e => onUpdateDebugLog(e.currentTarget.checked)} />
    </div>
    <div class="setting-row">
      <div class="setting-info">
        <span class="setting-title">{t("general.userAgent")}</span>
      </div>
      <input
        class="b3-text-field"
        type="text"
        data-omnikit-field="user-agent"
        value={generalDraft.userAgent}
        disabled={globalSaving || coreRecovery}
        oninput={e => onUpdateUserAgent(e.currentTarget.value)} />
    </div>

    {#if coreConflict}
      <div class="notice notice--error" role="alert">
        <span>{t("settings.concurrentChange")}</span>
        <button
          type="button"
          class="b3-button b3-button--outline"
          disabled={globalSaving}
          onclick={onDiscardReload}>
          {t("settings.discardReload")}
        </button>
      </div>
    {/if}
  </div>
</section>

<style lang="scss">
  .feature-card {
    background: var(--b3-theme-surface);
    border: 1px solid var(--b3-border-color);
    border-radius: 10px;
    padding: 1.25rem 1.5rem;
    box-shadow: 0 1px 4px color-mix(in srgb, var(--b3-theme-on-background) 6%, transparent);
    transition: border-color 0.2s ease, box-shadow 0.2s ease;
    scroll-margin-top: 1.25rem;
  }

  .card-header {
    display: flex;
    align-items: flex-start;
    justify-content: space-between;
    gap: 1.25rem;
    padding-bottom: 0.75rem;
    border-bottom: 1px solid var(--b3-border-color);
    margin-bottom: 1rem;
  }

  .card-title-group {
    flex: 1;
    min-width: 0;
  }

  .card-title {
    margin: 0;
    font-size: 1.15rem;
    font-weight: 600;
    color: var(--b3-theme-on-background);
  }

  .card-desc {
    margin: 0.3rem 0 0;
    font-size: 0.82rem;
    color: var(--b3-theme-on-surface-light);
    line-height: 1.4;
  }

  .card-body {
    user-select: text;
  }

  .setting-row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 1rem;
    padding: 0.5rem 0;
  }

  .setting-info {
    display: flex;
    flex-direction: column;
    gap: 0.2rem;
  }

  .setting-title {
    font-size: 0.92rem;
    font-weight: 500;
  }

  .setting-hint {
    font-size: 0.8rem;
    color: var(--b3-theme-on-surface-light);
  }

  .recovery-box {
    margin-bottom: 1rem;
    padding: 0.75rem;
    border-radius: 6px;
    background: color-mix(in srgb, var(--b3-theme-error) 12%, transparent);
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
  }

  .notice {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    justify-content: space-between;
    gap: 0.75rem;
    background: var(--b3-theme-surface-lighter, var(--b3-theme-surface));
    border-radius: 6px;
    padding: 0.75rem 1rem;
    margin-top: 0.75rem;
    line-height: 1.5;
    font-size: 0.85rem;
  }

  .notice--error {
    border-inline-start: 3px solid var(--b3-theme-error);
    color: var(--b3-theme-error);
    background: color-mix(in srgb, var(--b3-theme-error) 10%, transparent);
  }

  .omnikit-error {
    color: var(--b3-theme-error);
    margin: 0;
    font-size: 0.85rem;
  }
</style>
