<script lang="ts">
  import { onMount, untrack } from "svelte";
  import type { ImageTaskState, ImageTaskStateStore } from "./ImageTaskUI.ts";

  interface Props {
    job: ImageTaskStateStore;
    t: (key: string, values?: Record<string, string | number>) => string;
  }

  let { job, t }: Props = $props();
  let state = $state<ImageTaskState>(untrack(() => job.snapshot()));
  onMount(() => job.subscribe(next => { state = next; }));
  let active = $derived(["preparing", "preview", "applying"].includes(state.phase));
</script>

<section class="image-task" aria-busy={active}>
  <header>
    <h3>{t(`task.${state.phase}`)}</h3>
    <span class="task-id">{state.id}</span>
  </header>

  {#if state.phase === "preparing"}
    <progress max={Math.max(1, state.preparedTotal ?? state.total)} value={state.prepared ?? 0} aria-label={t("task.progress")}></progress>
  {:else if active}
    <progress aria-label={t("task.progress")}></progress>
  {/if}

  {#if state.currentFile}
    <div class="current-file" title={state.currentFile}>
      <span class="current-file-label">{t("task.currentFile") || "当前文件"}:</span>
      <span class="current-file-path">{state.currentFile}</span>
    </div>
  {/if}

  <div class="metrics">
    <div>
      <strong>{state.phase === "preparing" ? `${state.prepared ?? 0} / ${state.preparedTotal ?? state.total}` : `${state.completed} / ${state.total}`}</strong>
      <span>{t("task.prepared")}</span>
    </div>
    <div><strong>{state.uploaded}</strong><span>{t("task.uploaded")}</span></div>
    <div><strong>{state.skipped}</strong><span>{t("task.skipped")}</span></div>
    <div><strong>{state.failed}</strong><span>{t("task.failedItems")}</span></div>
    {#if state.unknown > 0}
      <div><strong>{state.unknown}</strong><span>{t("image.batch.unknownCount", { count: state.unknown })}</span></div>
    {/if}
  </div>

  {#if state.phase === "unknown"}
    <p class="warning" role="alert">{t("task.unknownHelp")}</p>
  {/if}

  {#if state.messages.length}
    <details>
      <summary>{t("task.details")}</summary>
      {#each state.messages as message}<p class="message">{message}</p>{/each}
    </details>
  {/if}

</section>

<style>
  .image-task { padding: 20px; min-width: 0; color: var(--b3-theme-on-background); }
  h3 { margin: 0 0 8px; }
  .task-id { overflow-wrap: anywhere; color: var(--b3-theme-on-surface); font-size: 12px; }
  progress { width: 100%; height: 8px; margin: 20px 0; accent-color: var(--b3-theme-primary); }
  .current-file { display: flex; align-items: center; gap: 8px; font-size: 12px; margin: 8px 0; color: var(--b3-theme-on-surface); }
  .current-file-path { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .metrics { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 12px; margin: 16px 0; }
  .metrics div { min-width: 0; padding: 12px; border: 1px solid var(--b3-border-color); border-radius: 6px; }
  .metrics strong, .metrics span { display: block; overflow-wrap: anywhere; }
  .metrics strong { font-size: 20px; font-variant-numeric: tabular-nums; }
  .metrics span { color: var(--b3-theme-on-surface); font-size: 12px; margin-top: 6px; }
  .warning { color: var(--b3-theme-error); }
  .message { overflow-wrap: anywhere; }
  details { max-height: 200px; overflow: auto; margin: 12px 0; }
  @media (max-width: 480px) { .metrics { grid-template-columns: repeat(2, minmax(0, 1fr)); } }
</style>
