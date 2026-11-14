<script lang="ts">
  import type { Snippet } from "svelte";

  interface Props {
    title: string;
    subtitle?: string;
    iconSvg?: string;
    busy?: boolean;
    cancelText?: string;
    confirmText?: string;
    confirmDisabled?: boolean;
    confirmDanger?: boolean;
    showFooter?: boolean;
    onCancel?: () => void;
    onConfirm?: () => void;
    children?: Snippet;
    extraActions?: Snippet;
  }

  let {
    title,
    subtitle,
    iconSvg,
    busy = false,
    cancelText = "取消",
    confirmText = "确定",
    confirmDisabled = false,
    confirmDanger = false,
    showFooter = true,
    onCancel,
    onConfirm,
    children,
    extraActions,
  }: Props = $props();
</script>

<div class="omnikit-dialog-shell">
  <header class="omnikit-dialog-header">
    <div class="omnikit-dialog-header__title-group">
      {#if iconSvg}
        <span class="omnikit-dialog-header__icon">{@html iconSvg}</span>
      {/if}
      <div>
        <h3 class="omnikit-dialog-header__title">{title}</h3>
        {#if subtitle}
          <p class="omnikit-dialog-header__subtitle">{subtitle}</p>
        {/if}
      </div>
    </div>
    {#if onCancel}
      <button
        type="button"
        class="omnikit-dialog-header__close b3-button b3-button--text"
        onclick={onCancel}
        aria-label="关闭"
        disabled={busy}
      >
        <svg class="b3-button__icon" viewBox="0 0 16 16"><path fill="currentColor" d="M12.7 3.3a1 1 0 0 0-1.4 0L8 6.6 4.7 3.3a1 1 0 0 0-1.4 1.4L6.6 8l-3.3 3.3a1 1 0 0 0 1.4 1.4L8 9.4l3.3 3.3a1 1 0 0 0 1.4-1.4L9.4 8l3.3-3.3a1 1 0 0 0 0-1.4z"/></svg>
      </button>
    {/if}
  </header>

  <main class="omnikit-dialog-body">
    {@render children?.()}
  </main>

  {#if showFooter}
    <footer class="omnikit-dialog-footer">
      <div class="omnikit-dialog-footer__left">
        {@render extraActions?.()}
      </div>
      <div class="omnikit-dialog-footer__right">
        {#if onCancel}
          <button
            type="button"
            class="b3-button b3-button--cancel"
            onclick={onCancel}
            disabled={busy}
          >
            {cancelText}
          </button>
        {/if}
        {#if onConfirm}
          <button
            type="button"
            class="b3-button {confirmDanger ? 'b3-button--error' : ''}"
            onclick={onConfirm}
            disabled={busy || confirmDisabled}
          >
            {confirmText}
          </button>
        {/if}
      </div>
    </footer>
  {/if}
</div>

<style lang="scss">
  .omnikit-dialog-shell {
    display: flex;
    flex-direction: column;
    min-width: 480px;
    max-width: 680px;
    background: var(--b3-theme-surface);
    color: var(--b3-theme-on-surface);
    border-radius: 12px;
    box-sizing: border-box;
    overflow: hidden;
  }

  .omnikit-dialog-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 16px 20px;
    border-bottom: 1px solid var(--b3-border-color);

    &__title-group {
      display: flex;
      align-items: center;
      gap: 10px;
      min-width: 0;
    }

    &__icon {
      display: flex;
      align-items: center;
      justify-content: center;
      width: 24px;
      height: 24px;
      color: var(--b3-theme-primary);
    }

    &__title {
      margin: 0;
      font-size: 15px;
      font-weight: 600;
      color: var(--b3-theme-on-surface);
      line-height: 1.4;
    }

    &__subtitle {
      margin: 2px 0 0;
      font-size: 12px;
      color: var(--b3-theme-on-surface-light);
      line-height: 1.3;
    }

    &__close {
      padding: 4px;
      border-radius: 6px;
      color: var(--b3-theme-on-surface-light);
      cursor: pointer;
      display: flex;
      align-items: center;
      justify-content: center;

      &:hover {
        color: var(--b3-theme-on-surface);
        background: var(--b3-theme-surface-lighter);
      }
    }
  }

  .omnikit-dialog-body {
    padding: 18px 20px;
    overflow-y: auto;
    max-height: calc(85vh - 120px);
    display: flex;
    flex-direction: column;
    gap: 16px;
  }

  .omnikit-dialog-footer {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 14px 20px;
    border-top: 1px solid var(--b3-border-color);
    background: var(--b3-theme-surface);

    &__left {
      display: flex;
      align-items: center;
      gap: 8px;
    }

    &__right {
      display: flex;
      align-items: center;
      gap: 10px;
      margin-left: auto;
    }
  }
</style>
