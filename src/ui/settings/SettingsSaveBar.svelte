<script lang="ts">
  interface Props {
    anyDirty: boolean;
    globalSaving: boolean;
    allReadOnly: boolean;
    hasAnyConflict: boolean;
    statusText: string;
    t: (key: string, values?: Record<string, string | number>) => string;
    onReset: () => void;
    onSave: () => void;
  }

  let {
    anyDirty,
    globalSaving,
    allReadOnly,
    hasAnyConflict,
    statusText,
    t,
    onReset,
    onSave,
  }: Props = $props();
</script>

<div class="omnikit-global-save-bar">
  <footer class="save-bar" class:save-bar--dirty={anyDirty} class:save-bar--busy={globalSaving}>
    <div class="save-bar__status" aria-live="polite">
      <span
        class="status-dot"
        class:status-dot--saved={!anyDirty && !globalSaving}
        class:status-dot--dirty={anyDirty && !globalSaving}
        class:status-dot--busy={globalSaving}></span>
      <span class="status-text">{statusText}</span>
    </div>
    <div class="save-bar__actions">
      <button
        type="button"
        class="bar-btn bar-btn--ghost"
        disabled={globalSaving || allReadOnly}
        onclick={onReset}>
        {t("settings.resetDraft")}
      </button>
      <button
        type="button"
        class="bar-btn bar-btn--primary"
        disabled={globalSaving || !anyDirty || hasAnyConflict}
        onclick={onSave}>
        {globalSaving ? t("settings.saving") : t("settings.save")}
      </button>
    </div>
  </footer>
</div>

<style lang="scss">
  .omnikit-global-save-bar {
    position: sticky;
    bottom: 0;
    z-index: 50;
    display: flex;
    justify-content: center;
    max-width: 52rem;
    margin: 0 auto;
    padding: 0.75rem 0 calc(0.75rem + env(safe-area-inset-bottom, 0px));
    pointer-events: none;
  }

  .save-bar {
    pointer-events: auto;
    display: inline-flex;
    align-items: center;
    gap: 16px;
    padding: 6px 8px 6px 18px;
    background: var(--b3-theme-surface);
    backdrop-filter: blur(20px) saturate(180%);
    -webkit-backdrop-filter: blur(20px) saturate(180%);
    border: 1px solid var(--b3-border-color);
    border-radius: 9999px;
    box-shadow: var(--b3-dialog-shadow, 0 10px 28px -4px color-mix(in srgb, var(--b3-theme-on-background) 16%, transparent));
    transition: all 0.25s cubic-bezier(0.16, 1, 0.3, 1);

    &:hover {
      box-shadow: var(--b3-dialog-shadow, 0 14px 36px -4px color-mix(in srgb, var(--b3-theme-on-background) 22%, transparent));
    }
  }

  .save-bar__status {
    display: flex;
    align-items: center;
    gap: 8px;
    font-size: 13px;
    font-weight: 500;
    color: var(--b3-theme-on-surface);
    user-select: none;
    padding-right: 4px;
  }

  .status-dot {
    width: 8px;
    height: 8px;
    border-radius: 50%;
    flex-shrink: 0;
    transition: background 0.2s, box-shadow 0.2s;
  }

  .status-dot--saved {
    background: var(--b3-theme-success, var(--b3-theme-primary));
    box-shadow: 0 0 6px color-mix(in srgb, var(--b3-theme-success, var(--b3-theme-primary)) 50%, transparent);
  }

  .status-dot--dirty {
    background: var(--b3-card-warning-color, var(--b3-theme-secondary));
    box-shadow: 0 0 8px color-mix(in srgb, var(--b3-card-warning-color, var(--b3-theme-secondary)) 60%, transparent);
    animation: omnikit-pulse 2s infinite ease-in-out;
  }

  .status-dot--busy {
    background: var(--b3-theme-primary);
    box-shadow: 0 0 8px color-mix(in srgb, var(--b3-theme-primary) 60%, transparent);
    animation: omnikit-pulse 1s infinite ease-in-out;
  }

  .status-text {
    white-space: nowrap;
    letter-spacing: -0.01em;
  }

  .save-bar__actions {
    display: flex;
    align-items: center;
    gap: 8px;
  }

  .bar-btn {
    appearance: none;
    cursor: pointer;
    border-radius: 9999px;
    height: 32px;
    padding: 0 16px;
    font-size: 12.5px;
    font-weight: 500;
    line-height: 1;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    border: none;
    outline: none;
    white-space: nowrap;
    transition: all 0.18s cubic-bezier(0.16, 1, 0.3, 1);

    &:active:not(:disabled) {
      transform: scale(0.97);
    }
  }

  .bar-btn--ghost {
    background: transparent;
    color: var(--b3-theme-on-surface);
    border: 1px solid transparent;

    &:hover:not(:disabled) {
      background: var(--b3-theme-surface-lighter);
      color: var(--b3-theme-on-background);
    }

    &:disabled {
      opacity: 0.4;
      cursor: not-allowed;
    }
  }

  .bar-btn--primary {
    background: var(--b3-theme-primary);
    color: var(--b3-theme-on-primary);
    box-shadow: 0 2px 8px color-mix(in srgb, var(--b3-theme-primary) 35%, transparent);

    &:hover:not(:disabled) {
      filter: brightness(1.08);
      box-shadow: 0 4px 14px color-mix(in srgb, var(--b3-theme-primary) 45%, transparent);
      transform: translateY(-0.5px);
    }

    &:disabled {
      background: var(--b3-theme-surface-lighter);
      color: var(--b3-theme-on-surface);
      opacity: 0.5;
      box-shadow: none;
      cursor: not-allowed;
    }
  }

  @keyframes omnikit-pulse {
    0%, 100% { opacity: 1; transform: scale(1); }
    50% { opacity: 0.45; transform: scale(0.85); }
  }

  @media (max-width: 680px) {
    .omnikit-global-save-bar {
      padding: 0.625rem 0 calc(0.75rem + env(safe-area-inset-bottom, 0px));
    }

    .save-bar {
      width: 100%;
      border-radius: 16px;
      padding: 10px 14px;
      flex-wrap: wrap;
      justify-content: space-between;
      gap: 10px;
    }
  }
</style>
