<script lang="ts">
  import type { Snippet } from "svelte";

  interface Props {
    title: string;
    description?: string;
    layout?: "horizontal" | "vertical";
    children?: Snippet;
  }

  let {
    title,
    description,
    layout = "horizontal",
    children,
  }: Props = $props();
</script>

<div class="omnikit-form-row omnikit-form-row--{layout}">
  <div class="omnikit-form-row__meta">
    <span class="omnikit-form-row__title">{title}</span>
    {#if description}
      <span class="omnikit-form-row__description">{description}</span>
    {/if}
  </div>
  <div class="omnikit-form-row__control">
    {@render children?.()}
  </div>
</div>

<style lang="scss">
  .omnikit-form-row {
    display: flex;
    box-sizing: border-box;

    &--horizontal {
      align-items: center;
      justify-content: space-between;
      gap: 16px;
    }

    &--vertical {
      flex-direction: column;
      gap: 8px;
      align-items: stretch;
    }

    &__meta {
      display: flex;
      flex-direction: column;
      gap: 3px;
      min-width: 0;
      flex: 1;
    }

    &__title {
      font-size: 13px;
      font-weight: 500;
      color: var(--b3-theme-on-surface);
      line-height: 1.4;
    }

    &__description {
      font-size: 12px;
      color: var(--b3-theme-on-surface-light);
      line-height: 1.35;
    }

    &__control {
      display: flex;
      align-items: center;
      gap: 8px;
      flex-shrink: 0;
    }
  }
</style>
