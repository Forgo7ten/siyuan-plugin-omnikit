<script lang="ts">
  interface Props {
    value: number;
    min?: number;
    max?: number;
    step?: number;
    disabled?: boolean;
    displayValue?: string | number;
    formatter?: (val: number) => string;
    oninput?: (val: number) => void;
    onchange?: (val: number) => void;
  }

  let {
    value = $bindable(),
    min = 0,
    max = 100,
    step = 1,
    disabled = false,
    displayValue,
    formatter,
    oninput,
    onchange,
  }: Props = $props();

  const formatted = $derived(
    displayValue !== undefined
      ? String(displayValue)
      : formatter
        ? formatter(value)
        : String(value)
  );

  function handleInput(e: Event) {
    const val = Number((e.target as HTMLInputElement).value);
    value = val;
    oninput?.(val);
  }

  function handleChange(e: Event) {
    const val = Number((e.target as HTMLInputElement).value);
    value = val;
    onchange?.(val);
  }
</script>

<div class="omnikit-slider {disabled ? 'is-disabled' : ''}">
  <input
    type="range"
    class="b3-slider omnikit-slider__input"
    {min}
    {max}
    {step}
    {disabled}
    {value}
    oninput={handleInput}
    onchange={handleChange}
  />
  <span class="omnikit-slider__badge">{formatted}</span>
</div>

<style lang="scss">
  .omnikit-slider {
    display: flex;
    align-items: center;
    gap: 12px;
    width: 100%;

    &.is-disabled {
      opacity: 0.5;
      pointer-events: none;
    }

    &__input {
      flex: 1;
      height: 6px;
      cursor: pointer;
      accent-color: var(--b3-theme-primary);
    }

    &__badge {
      font-size: 12px;
      font-variant-numeric: tabular-nums;
      padding: 2px 7px;
      border-radius: 4px;
      background: var(--b3-theme-surface-lighter);
      color: var(--b3-theme-on-surface);
      font-weight: 600;
      min-width: 44px;
      text-align: center;
    }
  }
</style>
