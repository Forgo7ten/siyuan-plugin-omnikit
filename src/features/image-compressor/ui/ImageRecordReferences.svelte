<script lang="ts">
  import type { CompressionRecord } from "../policy/contracts.ts";
  import type { OccurrenceItem, UnsupportedReferenceItem } from "../services/ImageReferences.ts";

  interface Props {
    record: CompressionRecord;
    mode: "original" | "compressed";
    occurrences: OccurrenceItem[];
    unsupportedRefs: UnsupportedReferenceItem[];
    busy: boolean;
    t: (key: string, values?: Record<string, string | number>) => string;
    onJumpToBlock: (blockID: string) => void;
    onApplyOccurrenceAction: (
      record: CompressionRecord,
      mode: "original" | "compressed",
      items: OccurrenceItem[],
    ) => void;
  }

  let {
    record,
    mode,
    occurrences,
    unsupportedRefs,
    busy,
    t,
    onJumpToBlock,
    onApplyOccurrenceAction,
  }: Props = $props();

  let imageItems = $derived(occurrences.filter(item => item.target.kind !== "link"));
  let linkItems = $derived(occurrences.filter(item => item.target.kind === "link"));
</script>

<div class="image-records__references">
  <div class="image-records__ref-header">
    <h4 class="image-records__ref-title">
      {mode === "original"
        ? t("image.records.originalReferences")
        : t("image.records.compressedReferences")}
    </h4>
    <p class="image-records__ref-desc">
      {mode === "original"
        ? t("image.records.originalReferencesDesc")
        : t("image.records.compressedReferencesDesc")}
    </p>
  </div>

  {#if imageItems.length}
    <div class="image-records__ref-group">
      <span class="image-records__ref-group-title">{t("image.records.imageRefs", { count: imageItems.length })}</span>
      <div class="image-records__occurrences">
        {#each imageItems as item (item.key)}
          <div class="image-records__occurrence-row">
            <button
              type="button"
              class="image-records__jump-btn"
              title={item.label}
              onclick={() => onJumpToBlock(item.target.blockID)}
            >
              <svg class="image-records__jump-icon" viewBox="0 0 16 16" width="12" height="12" fill="currentColor">
                <path d="M4.75 3a.75.75 0 0 0-.75.75v8.5c0 .414.336.75.75.75h6.5a.75.75 0 0 0 .75-.75v-8.5a.75.75 0 0 0-.75-.75h-6.5ZM2.5 3.75A2.25 2.25 0 0 1 4.75 1.5h6.5A2.25 2.25 0 0 1 13.5 3.75v8.5a2.25 2.25 0 0 1-2.25 2.25h-6.5A2.25 2.25 0 0 1 2.5 12.25v-8.5Z"/>
              </svg>
              <span class="image-records__jump-text">{item.label}</span>
            </button>
            <button
              type="button"
              class="b3-button b3-button--outline image-records__action-btn"
              disabled={busy}
              onclick={() => onApplyOccurrenceAction(record, mode, [item])}
            >
              {mode === "original" ? t("image.records.replaceThis") : t("image.records.restoreThis")}
            </button>
          </div>
        {/each}
      </div>
    </div>
  {/if}

  {#if linkItems.length}
    <div class="image-records__ref-group">
      <span class="image-records__ref-group-title">{t("image.records.linkRefs", { count: linkItems.length })}</span>
      <div class="image-records__occurrences">
        {#each linkItems as item (item.key)}
          <div class="image-records__occurrence-row">
            <button
              type="button"
              class="image-records__jump-btn"
              title={item.label}
              onclick={() => onJumpToBlock(item.target.blockID)}
            >
              <svg class="image-records__jump-icon" viewBox="0 0 16 16" width="12" height="12" fill="currentColor">
                <path d="M4.75 3a.75.75 0 0 0-.75.75v8.5c0 .414.336.75.75.75h6.5a.75.75 0 0 0 .75-.75v-8.5a.75.75 0 0 0-.75-.75h-6.5ZM2.5 3.75A2.25 2.25 0 0 1 4.75 1.5h6.5A2.25 2.25 0 0 1 13.5 3.75v8.5a2.25 2.25 0 0 1-2.25 2.25h-6.5A2.25 2.25 0 0 1 2.5 12.25v-8.5Z"/>
              </svg>
              <span class="image-records__jump-text">{item.label}</span>
            </button>
            <button
              type="button"
              class="b3-button b3-button--outline image-records__action-btn"
              disabled={busy}
              onclick={() => onApplyOccurrenceAction(record, mode, [item])}
            >
              {mode === "original" ? t("image.records.replaceThis") : t("image.records.restoreThis")}
            </button>
          </div>
        {/each}
      </div>
    </div>
  {/if}

  {#if unsupportedRefs.length}
    <div class="image-records__ref-group">
      <span class="image-records__ref-group-title">{t("image.records.unsupportedRefs", { count: unsupportedRefs.length })}</span>
      <div class="image-records__occurrences">
        {#each unsupportedRefs as item (item.key)}
          <div class="image-records__occurrence-row">
            <button
              type="button"
              class="image-records__jump-btn"
              title={item.label}
              onclick={() => onJumpToBlock(item.blockID || item.rootID)}
            >
              <svg class="image-records__jump-icon" viewBox="0 0 16 16" width="12" height="12" fill="currentColor">
                <path d="M4.75 3a.75.75 0 0 0-.75.75v8.5c0 .414.336.75.75.75h6.5a.75.75 0 0 0 .75-.75v-8.5a.75.75 0 0 0-.75-.75h-6.5ZM2.5 3.75A2.25 2.25 0 0 1 4.75 1.5h6.5A2.25 2.25 0 0 1 13.5 3.75v8.5a2.25 2.25 0 0 1-2.25 2.25h-6.5A2.25 2.25 0 0 1 2.5 12.25v-8.5Z"/>
              </svg>
              <span class="image-records__jump-text">{item.label}</span>
            </button>
          </div>
        {/each}
      </div>
    </div>
  {/if}

  {#if occurrences.length}
    <div class="image-records__batch-actions">
      <button
        type="button"
        class="b3-button"
        disabled={busy || !occurrences.length}
        onclick={() => onApplyOccurrenceAction(record, mode, occurrences)}
      >
        {mode === "original" ? t("image.records.replaceAll") : t("image.records.restoreAll")}
      </button>
    </div>
  {:else if !busy && !unsupportedRefs.length}
    <p class="image-records__empty-refs">{mode === "original" ? t("image.records.noOriginalReferences") : t("image.records.noCompressedReferences")}</p>
  {/if}
</div>

<style>
  .image-records__references {
    display: flex;
    flex-direction: column;
    gap: 6px;
    padding: 8px;
    margin-top: 6px;
    background: var(--b3-theme-background);
    border-radius: 6px;
  }
  .image-records__ref-header {
    display: flex;
    flex-direction: column;
    gap: 2px;
  }
  .image-records__ref-title {
    margin: 0;
    font-size: 12px;
    font-weight: 600;
  }
  .image-records__ref-desc {
    margin: 0;
    font-size: 11px;
    color: var(--b3-theme-on-surface);
    opacity: 0.7;
  }
  .image-records__ref-group {
    display: flex;
    flex-direction: column;
    gap: 4px;
    margin-top: 4px;
  }
  .image-records__ref-group-title {
    font-size: 11px;
    font-weight: 600;
    color: var(--b3-theme-on-surface);
    opacity: 0.8;
  }
  .image-records__occurrences {
    display: flex;
    flex-direction: column;
    gap: 4px;
    margin-top: 2px;
  }
  .image-records__occurrence-row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
    padding: 2px 0;
  }
  .image-records__jump-btn {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    flex: 1;
    min-width: 0;
    background: transparent;
    border: none;
    padding: 3px 6px;
    border-radius: 4px;
    cursor: pointer;
    text-align: left;
    color: var(--b3-theme-on-surface);
    transition: background 0.15s ease, color 0.15s ease;
  }
  .image-records__jump-btn:hover {
    background: var(--b3-theme-surface-lighter);
    color: var(--b3-theme-primary);
  }
  .image-records__jump-icon {
    flex-shrink: 0;
    opacity: 0.7;
  }
  .image-records__jump-text {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    font-size: 11px;
  }
  .image-records__action-btn {
    flex-shrink: 0;
    font-size: 11px;
    padding: 2px 8px;
  }
  .image-records__batch-actions {
    display: flex;
    justify-content: flex-end;
    margin-top: 6px;
  }
  .image-records__batch-actions button {
    font-size: 11px;
    padding: 3px 10px;
  }
  .image-records__empty-refs {
    margin: 4px 0 0 0;
    font-size: 11px;
    color: var(--b3-theme-on-surface);
    opacity: 0.7;
  }
</style>
