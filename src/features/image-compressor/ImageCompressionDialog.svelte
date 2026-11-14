<script lang="ts">
  import { onDestroy, onMount } from "svelte";
  import type { ManualCompressionPreview } from "./SingleImageAction.ts";
  import OmniFormRow from "../../ui/components/OmniFormRow.svelte";
  import OmniSlider from "../../ui/components/OmniSlider.svelte";

  interface Props {
    sourceName: string;
    defaults: { quality: number; manualMaxEdge: number };
    t: (key: string) => string;
    previewEncode: (quality: number, manualMaxEdge: number) => Promise<ManualCompressionPreview>;
    save: (preview: ManualCompressionPreview, replace: boolean) => Promise<void>;
    onClose?: () => void;
  }

  let { sourceName, defaults, t, previewEncode, save, onClose }: Props = $props();
  let quality = $state(0.8);
  let manualMaxEdge = $state(4096);
  let replaceCurrent = $state(false);
  let allowLarger = $state(false);
  let preview = $state<ManualCompressionPreview | undefined>();
  let previewURL = $state("");
  let originalURL = $state("");
  let busy = $state(false);
  let error = $state("");

  onMount(() => {
    quality = defaults.quality;
    manualMaxEdge = defaults.manualMaxEdge;
  });

  async function prepare(): Promise<void> {
    if (busy || !Number.isFinite(quality) || quality < 0.01 || quality > 1
      || !Number.isInteger(manualMaxEdge) || manualMaxEdge < 512 || manualMaxEdge > 16384) {
      error = t("image.dialog.invalidSettings");
      return;
    }
    busy = true;
    error = "";
    try {
      const encoded = await previewEncode(quality, manualMaxEdge);
      if (previewURL) URL.revokeObjectURL(previewURL);
      if (originalURL) URL.revokeObjectURL(originalURL);
      preview = encoded;
      previewURL = URL.createObjectURL(encoded.file);
      originalURL = URL.createObjectURL(encoded.originalBlob);
      allowLarger = false;
    } catch {
      error = t("image.dialog.previewFailed");
    } finally {
      busy = false;
    }
  }

  async function apply(): Promise<void> {
    if (!preview || busy || preview.compressedBytes > preview.originalBytes && !allowLarger) return;
    busy = true;
    error = "";
    try {
      await save(preview, replaceCurrent);
    } catch {
      error = t("image.dialog.saveFailed");
    } finally {
      busy = false;
    }
  }

  function formatBytes(bytes: number): string {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
  }

  function discardPreview(): void {
    preview = undefined;
    allowLarger = false;
    if (previewURL) URL.revokeObjectURL(previewURL);
    if (originalURL) URL.revokeObjectURL(originalURL);
    previewURL = "";
    originalURL = "";
  }

  onDestroy(() => {
    if (previewURL) URL.revokeObjectURL(previewURL);
    if (originalURL) URL.revokeObjectURL(originalURL);
  });
</script>

<div class="omnikit-image-compression-dialog" aria-label={t("image.dialog.title")}>
  <!-- Source file banner -->
  <div class="dialog-banner">
    <div class="dialog-banner__file">
      <svg class="dialog-banner__icon" viewBox="0 0 16 16"><path fill="currentColor" d="M14 2H2a1 1 0 0 0-1 1v10a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1V3a1 1 0 0 0-1-1zm-1 10H3V4h10v8zm-2.5-4a1.5 1.5 0 1 1-3 0 1.5 1.5 0 0 1 3 0zm-5 3h7l-2.25-3-1.75 2.33-1.25-1.67L5.5 11z"/></svg>
      <span class="dialog-banner__name" title={sourceName}>{sourceName}</span>
    </div>
  </div>

  <!-- Parameter Settings Card -->
  <div class="dialog-card">
    <OmniFormRow title={t("image.dialog.quality")} description="压缩质量越低，体积越小">
      <div class="slider-wrapper">
        <OmniSlider
          bind:value={quality}
          min={0.01}
          max={1}
          step={0.01}
          disabled={busy}
          displayValue={`${Math.round(quality * 100)}%`}
          oninput={discardPreview}
        />
      </div>
    </OmniFormRow>

    <div class="card-divider"></div>

    <OmniFormRow title={t("image.dialog.maxEdge")} description="原图长边超过此像素时等比缩减，保持宽高比">
      <div class="edge-input-group">
        <input
          aria-label={t("image.dialog.maxEdge")}
          class="b3-text-field edge-input"
          type="number"
          min="512"
          max="16384"
          step="1"
          bind:value={manualMaxEdge}
          oninput={discardPreview}
          disabled={busy}
        />
        <span class="edge-unit">px</span>
      </div>
    </OmniFormRow>

    <div class="card-divider"></div>

    <div class="dialog-options">
      <label class="dialog-option-item">
        <input type="checkbox" class="b3-switch" bind:checked={replaceCurrent} disabled={busy} />
        <span class="dialog-option-label">{t("image.dialog.replaceCurrent")}</span>
      </label>
      <label class="dialog-option-item is-disabled">
        <input type="checkbox" class="b3-switch" disabled checked={false} />
        <span class="dialog-option-label">{t("image.dialog.preserveExif")}</span>
      </label>
    </div>

    <div class="preview-action-row">
      <button
        class="b3-button b3-button--outline preview-btn"
        type="button"
        onclick={prepare}
        disabled={busy}
      >
        <svg class="btn-icon" viewBox="0 0 16 16"><path fill="currentColor" d="M8 3.5C4.5 3.5 1.6 5.8.5 9c1.1 3.2 4 5.5 7.5 5.5s6.4-2.3 7.5-5.5c-1.1-3.2-4-5.5-7.5-5.5zm0 9A3.5 3.5 0 1 1 8 5.5a3.5 3.5 0 0 1 0 7zm0-5.5a2 2 0 1 0 0 4 2 2 0 0 0 0-4z"/></svg>
        {busy ? "正在处理…" : preview ? "重新生成预览" : t("image.dialog.preview")}
      </button>
    </div>
  </div>

  <!-- Preview Comparison Cards -->
  {#if preview}
    <div class="previews-container">
      <div class="preview-card">
        <div class="preview-card__header">
          <span class="preview-card__title">{t("image.dialog.original")}</span>
          <span class="preview-card__tag">{formatBytes(preview.originalBytes)}</span>
        </div>
        <div class="preview-card__img-box">
          {#if originalURL}
            <img src={originalURL} alt={sourceName} />
          {/if}
        </div>
      </div>

      <div class="preview-card preview-card--webp">
        <div class="preview-card__header">
          <span class="preview-card__title">{t("image.dialog.webpPreview")}</span>
          <div class="preview-card__badges">
            <span class="preview-card__tag preview-card__tag--highlight">
              {formatBytes(preview.compressedBytes)}
            </span>
            {#if preview.compressedBytes <= preview.originalBytes}
              <span class="saving-badge saving-badge--success">
                -{Math.round((1 - preview.compressedBytes / preview.originalBytes) * 100)}%
              </span>
            {:else}
              <span class="saving-badge saving-badge--warn">
                +{Math.round((preview.compressedBytes / preview.originalBytes - 1) * 100)}%
              </span>
            {/if}
          </div>
        </div>
        <div class="preview-card__img-box">
          <img src={previewURL} alt={t("image.dialog.webpPreview")} />
        </div>
        <div class="preview-card__footer">
          <span>{preview.width} × {preview.height} px</span>
          {#if preview.compressedBytes <= preview.originalBytes}
            <span>节省 {formatBytes(preview.originalBytes - preview.compressedBytes)}</span>
          {/if}
        </div>
      </div>
    </div>

    {#if preview.compressedBytes > preview.originalBytes}
      <div class="larger-warning-bar">
        <label class="dialog-option-item">
          <input type="checkbox" bind:checked={allowLarger} disabled={busy} />
          <span class="b3-text-warning">{t("image.dialog.largerOutputWarning")}</span>
        </label>
      </div>
    {/if}
  {/if}

  {#if error}
    <p class="b3-text-error dialog-error-msg" role="alert">{error}</p>
  {/if}

  <!-- Footer Action Bar -->
  <div class="dialog-footer-actions">
    {#if onClose}
      <button
        class="b3-button b3-button--cancel"
        type="button"
        onclick={onClose}
        disabled={busy}
      >
        {t("common.cancel")}
      </button>
    {/if}
    <button
      class="b3-button save-btn"
      type="button"
      onclick={apply}
      disabled={!preview || busy || (preview.compressedBytes > preview.originalBytes && !allowLarger)}
    >
      {t("image.dialog.save")}
    </button>
  </div>
</div>

<style lang="scss">
  .omnikit-image-compression-dialog {
    display: flex;
    flex-direction: column;
    gap: 16px;
    padding: 4px;
    box-sizing: border-box;
    font-size: 13px;
  }

  .dialog-banner {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 10px 14px;
    background: var(--b3-theme-surface-lighter);
    border-radius: 8px;

    &__file {
      display: flex;
      align-items: center;
      gap: 8px;
      min-width: 0;
      flex: 1;
    }

    &__icon {
      width: 18px;
      height: 18px;
      color: var(--b3-theme-primary);
      flex-shrink: 0;
    }

    &__name {
      font-weight: 500;
      color: var(--b3-theme-on-surface);
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
  }

  .dialog-card {
    display: flex;
    flex-direction: column;
    gap: 14px;
    padding: 16px;
    background: var(--b3-theme-surface);
    border: 1px solid var(--b3-border-color);
    border-radius: 10px;
  }

  .card-divider {
    height: 1px;
    background: var(--b3-border-color);
    opacity: 0.6;
  }

  .slider-wrapper {
    width: 240px;
  }

  .edge-input-group {
    display: flex;
    align-items: center;
    gap: 6px;
  }

  .edge-input {
    width: 100px;
    text-align: right;
  }

  .edge-unit {
    color: var(--b3-theme-on-surface-light);
    font-size: 12px;
  }

  .dialog-options {
    display: flex;
    flex-direction: column;
    gap: 10px;
  }

  .dialog-option-item {
    display: flex;
    align-items: center;
    gap: 10px;
    cursor: pointer;
    user-select: none;

    &.is-disabled {
      opacity: 0.5;
      cursor: not-allowed;
    }
  }

  .dialog-option-label {
    color: var(--b3-theme-on-surface);
    font-size: 13px;
  }

  .preview-action-row {
    display: flex;
    justify-content: flex-end;
    margin-top: 4px;
  }

  .preview-btn {
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 6px 16px;
  }

  .btn-icon {
    width: 14px;
    height: 14px;
  }

  .previews-container {
    display: grid;
    grid-template-columns: repeat(2, minmax(0, 1fr));
    gap: 14px;
  }

  .preview-card {
    display: flex;
    flex-direction: column;
    border: 1px solid var(--b3-border-color);
    border-radius: 10px;
    overflow: hidden;
    background: var(--b3-theme-surface);

    &__header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 10px 14px;
      border-bottom: 1px solid var(--b3-border-color);
      background: var(--b3-theme-surface-lighter);
    }

    &__title {
      font-weight: 600;
      color: var(--b3-theme-on-surface);
    }

    &__badges {
      display: flex;
      align-items: center;
      gap: 6px;
    }

    &__tag {
      font-size: 12px;
      font-weight: 500;
      color: var(--b3-theme-on-surface-light);

      &--highlight {
        color: var(--b3-theme-primary);
        font-weight: 600;
      }
    }

    &__img-box {
      height: 220px;
      display: flex;
      align-items: center;
      justify-content: center;
      padding: 10px;
      background: repeating-conic-gradient(var(--b3-border-color) 0% 25%, transparent 0% 50%) 50% / 16px 16px;
      overflow: hidden;

      img {
        max-width: 100%;
        max-height: 100%;
        object-fit: contain;
        border-radius: 4px;
        box-shadow: 0 2px 8px rgba(0, 0, 0, 0.1);
      }
    }

    &__footer {
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 8px 12px;
      font-size: 12px;
      color: var(--b3-theme-on-surface-light);
      border-top: 1px solid var(--b3-border-color);
    }
  }

  .saving-badge {
    font-size: 11px;
    font-weight: 600;
    padding: 2px 6px;
    border-radius: 4px;

    &--success {
      background: var(--b3-theme-success, #2ba471);
      color: #fff;
    }

    &--warn {
      background: var(--b3-theme-error);
      color: #fff;
    }
  }

  .larger-warning-bar {
    padding: 10px 14px;
    border-radius: 8px;
    background: var(--b3-theme-surface-lighter);
    border: 1px dashed var(--b3-theme-error);
  }

  .dialog-error-msg {
    margin: 0;
    font-size: 12px;
  }

  .dialog-footer-actions {
    display: flex;
    align-items: center;
    justify-content: flex-end;
    gap: 10px;
    margin-top: 8px;
  }

  .save-btn {
    min-width: 90px;
  }

  @media (max-width: 580px) {
    .previews-container {
      grid-template-columns: 1fr;
    }
  }
</style>
