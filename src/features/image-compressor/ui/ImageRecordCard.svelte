<script lang="ts">
  import type { AssetAvailability, CompressionRecord } from "../policy/contracts.ts";
  import { trySource } from "../policy/source.ts";
  import type { OccurrenceItem, UnsupportedReferenceItem } from "../services/ImageReferences.ts";
  import { isRemoteRecordSource } from "../store/ImageCompressionRecordStore.ts";
  import ImageRecordReferences from "./ImageRecordReferences.svelte";

  export type DisplayStatus = AssetAvailability | "checking";

  interface Props {
    record: CompressionRecord;
    origin: string;
    origStatus: DisplayStatus;
    compStatus: DisplayStatus;
    expandedMode: "original" | "compressed" | null;
    occurrences: OccurrenceItem[];
    unsupportedRefs: UnsupportedReferenceItem[];
    busy: boolean;
    t: (key: string, values?: Record<string, string | number>) => string;
    onCopyPath: (path: string) => void;
    onToggleOriginalReferences: (record: CompressionRecord) => void;
    onLocateRestoreOccurrences: (record: CompressionRecord) => void;
    onRemoveRecord: (record: CompressionRecord) => void;
    onJumpToBlock: (blockID: string) => void;
    onApplyOccurrenceAction: (
      record: CompressionRecord,
      mode: "original" | "compressed",
      items: OccurrenceItem[],
    ) => void;
  }

  let {
    record,
    origin,
    origStatus,
    compStatus,
    expandedMode,
    occurrences,
    unsupportedRefs,
    busy,
    t,
    onCopyPath,
    onToggleOriginalReferences,
    onLocateRestoreOccurrences,
    onRemoveRecord,
    onJumpToBlock,
    onApplyOccurrenceAction,
  }: Props = $props();

  let isRemote = $derived(isRemoteRecordSource(record.originalPath));

  function previewSrc(path: string): string {
    const parsed = trySource(path, origin);
    return parsed?.kind === "asset" ? parsed.fetchURL : `/${path}`;
  }

  function badgeVariant(status: DisplayStatus | undefined): "checking" | "present" | "missing" | "unknown" {
    if (status === "checking") return "checking";
    if (status === "present") return "present";
    if (status === "missing-confirmed") return "missing";
    return "unknown";
  }

  function badgeTextKey(status: DisplayStatus | undefined): string {
    if (status === "checking") return "image.records.assetStatus.checking";
    if (status === "present") return "image.records.assetStatus.present";
    if (status === "missing-confirmed") return "image.records.assetStatus.missing";
    return "image.records.assetStatus.unknown";
  }
</script>

<li class="image-records__card">
  <div class="image-records__card-preview">
    <img
      class="image-records__img"
      src={previewSrc(record.compressedPath)}
      alt={t("image.records.previewAlt")}
      loading="lazy"
    />
  </div>

  <div class="image-records__card-body">
    <div class="image-records__row">
      <span class="image-records__label">{t("image.records.original")}</span>
      <button
        type="button"
        class="image-records__path-btn"
        title={t("image.records.clickToCopy")}
        onclick={() => onCopyPath(record.originalPath)}
      >
        <code class="image-records__path">{record.originalPath}</code>
        <svg class="image-records__copy-icon" viewBox="0 0 16 16" width="12" height="12" fill="currentColor">
          <path d="M0 6.75C0 5.784.784 5 1.75 5h1.5a.75.75 0 0 1 0 1.5h-1.5a.25.25 0 0 0-.25.25v7.5c0 .138.112.25.25.25h7.5a.25.25 0 0 0 .25-.25v-1.5a.75.75 0 0 1 1.5 0v1.5A1.75 1.75 0 0 1 9.25 16h-7.5A1.75 1.75 0 0 1 0 14.25Z" />
          <path d="M5 1.75C5 .784 5.784 0 6.75 0h7.5C15.216 0 16 .784 16 1.75v7.5A1.75 1.75 0 0 1 14.25 11h-7.5A1.75 1.75 0 0 1 5 9.25Zm1.75-.25a.25.25 0 0 0-.25.25v7.5c0 .138.112.25.25.25h7.5a.25.25 0 0 0 .25-.25v-7.5a.25.25 0 0 0-.25-.25Z" />
        </svg>
      </button>
      {#if !isRemote}
        <span
          class={`image-records__badge image-records__badge--${badgeVariant(origStatus)}`}
          title={t("image.records.originalStatus")}
        >
          {#if origStatus === "checking"}
            <span class="image-records__spinner image-records__spinner--small" aria-hidden="true"></span>
          {/if}
          {t(badgeTextKey(origStatus))}
        </span>
      {/if}
    </div>

    <div class="image-records__row">
      <span class="image-records__label">{t("image.records.compressed")}</span>
      <button
        type="button"
        class="image-records__path-btn"
        title={t("image.records.clickToCopy")}
        onclick={() => onCopyPath(record.compressedPath)}
      >
        <code class="image-records__path">{record.compressedPath}</code>
        <svg class="image-records__copy-icon" viewBox="0 0 16 16" width="12" height="12" fill="currentColor">
          <path d="M0 6.75C0 5.784.784 5 1.75 5h1.5a.75.75 0 0 1 0 1.5h-1.5a.25.25 0 0 0-.25.25v7.5c0 .138.112.25.25.25h7.5a.25.25 0 0 0 .25-.25v-1.5a.75.75 0 0 1 1.5 0v1.5A1.75 1.75 0 0 1 9.25 16h-7.5A1.75 1.75 0 0 1 0 14.25Z" />
          <path d="M5 1.75C5 .784 5.784 0 6.75 0h7.5C15.216 0 16 .784 16 1.75v7.5A1.75 1.75 0 0 1 14.25 11h-7.5A1.75 1.75 0 0 1 5 9.25Zm1.75-.25a.25.25 0 0 0-.25.25v7.5c0 .138.112.25.25.25h7.5a.25.25 0 0 0 .25-.25v-7.5a.25.25 0 0 0-.25-.25Z" />
        </svg>
      </button>
      <span
        class={`image-records__badge image-records__badge--${badgeVariant(compStatus)}`}
        title={t("image.records.compressedStatus")}
      >
        {#if compStatus === "checking"}
          <span class="image-records__spinner image-records__spinner--small" aria-hidden="true"></span>
        {/if}
        {t(badgeTextKey(compStatus))}
      </span>
    </div>

    <div class="image-records__meta">
      <span class="image-records__meta-item">
        {new Date(record.updatedAt).toLocaleString()}
      </span>
      <span class="image-records__meta-tag">
        {t(`image.records.operation.${record.lastOperation}`)}
      </span>
    </div>

    <div class="image-records__actions">
      <button
        type="button"
        class="b3-button b3-button--outline"
        disabled={busy || (!isRemote && origStatus !== "present")}
        onclick={() => onLocateRestoreOccurrences(record)}
      >
        {expandedMode === "compressed"
          ? t("image.records.hideReferences")
          : t("image.records.findCompressedReferences")}
      </button>
      <button
        type="button"
        class="b3-button b3-button--outline"
        disabled={busy}
        onclick={() => onToggleOriginalReferences(record)}
      >
        {expandedMode === "original"
          ? t("image.records.hideReferences")
          : t("image.records.findOriginalReferences")}
      </button>
      <button
        type="button"
        class="b3-button b3-button--cancel"
        disabled={busy}
        onclick={() => onRemoveRecord(record)}
      >
        {t("image.records.remove")}
      </button>
    </div>

    {#if expandedMode}
      <ImageRecordReferences
        {record}
        mode={expandedMode}
        {occurrences}
        {unsupportedRefs}
        {busy}
        {t}
        {onJumpToBlock}
        {onApplyOccurrenceAction}
      />
    {/if}
  </div>
</li>

<style>
  .image-records__card {
    display: flex;
    flex-direction: column;
    gap: 10px;
    padding: 12px;
    background: var(--b3-theme-surface);
    border: 1px solid var(--b3-theme-surface-lighter);
    border-radius: 8px;
    box-shadow: 0 1px 3px color-mix(in srgb, var(--b3-theme-on-background) 6%, transparent);
  }
  .image-records__card-preview {
    display: flex;
    align-items: center;
    justify-content: center;
    max-height: 140px;
    background: var(--b3-theme-background);
    border-radius: 6px;
    overflow: hidden;
  }
  .image-records__img {
    max-width: 100%;
    max-height: 140px;
    object-fit: contain;
  }
  .image-records__card-body {
    display: flex;
    flex-direction: column;
    gap: 8px;
  }
  .image-records__row {
    display: flex;
    align-items: center;
    gap: 6px;
    font-size: 12px;
    min-width: 0;
  }
  .image-records__label {
    flex-shrink: 0;
    color: var(--b3-theme-on-surface);
    opacity: 0.75;
    font-size: 11px;
    width: 48px;
  }
  .image-records__path-btn {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    flex: 1;
    min-width: 0;
    padding: 2px 6px;
    background: var(--b3-theme-surface-lighter);
    border: 1px solid transparent;
    border-radius: 4px;
    cursor: pointer;
    text-align: left;
    transition: all 0.15s ease;
  }
  .image-records__path-btn:hover {
    border-color: var(--b3-theme-primary);
    background: var(--b3-theme-background);
  }
  .image-records__path {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    font-family: var(--b3-font-family-code);
    font-size: 11px;
    color: var(--b3-theme-primary);
  }
  .image-records__copy-icon {
    flex-shrink: 0;
    opacity: 0.6;
  }
  .image-records__path-btn:hover .image-records__copy-icon {
    opacity: 1;
    color: var(--b3-theme-primary);
  }
  .image-records__badge {
    flex-shrink: 0;
    display: inline-flex;
    align-items: center;
    gap: 3px;
    padding: 1px 6px;
    border-radius: 4px;
    font-size: 11px;
    font-weight: 500;
  }
  .image-records__badge--present {
    background: color-mix(in srgb, var(--b3-theme-primary) 12%, transparent);
    color: var(--b3-theme-primary);
  }
  .image-records__badge--missing {
    background: color-mix(in srgb, var(--b3-theme-error) 12%, transparent);
    color: var(--b3-theme-error);
  }
  .image-records__badge--checking {
    background: color-mix(in srgb, var(--b3-theme-secondary) 12%, transparent);
    color: var(--b3-theme-secondary);
  }
  .image-records__badge--unknown {
    background: var(--b3-theme-surface-lighter);
    color: var(--b3-theme-on-surface);
    opacity: 0.7;
  }
  .image-records__spinner {
    display: inline-block;
    width: 12px;
    height: 12px;
    border: 2px solid currentColor;
    border-right-color: transparent;
    border-radius: 50%;
    animation: image-records-spin 0.75s linear infinite;
  }
  .image-records__spinner--small {
    width: 9px;
    height: 9px;
    border-width: 1.5px;
  }
  @keyframes image-records-spin {
    to { transform: rotate(360deg); }
  }
  .image-records__meta {
    display: flex;
    align-items: center;
    justify-content: space-between;
    font-size: 11px;
    color: var(--b3-theme-on-surface);
    opacity: 0.65;
    padding: 2px 0;
  }
  .image-records__meta-tag {
    background: var(--b3-theme-surface-lighter);
    padding: 1px 6px;
    border-radius: 3px;
  }
  .image-records__actions {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 6px;
    margin-top: 4px;
  }
  .image-records__actions button {
    font-size: 11px;
    padding: 3px 8px;
  }
</style>
