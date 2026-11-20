<script lang="ts">
  import { onMount, untrack } from "svelte";
  import type { FeaturePhase } from "../../../core/framework/BaseFeature.ts";
  import type { JsonStore } from "../../../core/store/JsonStore.ts";
  import { SettingsConflictError, isSettingsConflictError } from "../../../core/store/SettingsConflictError.ts";
  import { describeError } from "../../../core/host/describeError.ts";
  import type { ImageFeatureConfig } from "../policy/parseImageConfig.ts";
  import { defaultImageFeatureConfig, NODE_ID, parseImageConfig } from "../policy/parseImageConfig.ts";
  import { KernelClient } from "../../../core/host/KernelClient.ts";
  import { resolveDocumentTitle } from "../services/documentTitle.ts";

  interface Props {
    store: JsonStore<ImageFeatureConfig>;
    runtimePhase: FeaturePhase | "configured";
    hostVersion: string;
    desktopFrontend?: boolean;
    t: (key: string, values?: Record<string, string | number>) => string;
    validateDocument: (rootID: string) => Promise<{ id: string; title: string }>;
  }
  let { store, runtimePhase, hostVersion, desktopFrontend = false, t, validateDocument }: Props = $props();
  const copy = (value: ImageFeatureConfig): ImageFeatureConfig => JSON.parse(JSON.stringify(value)) as ImageFeatureConfig;
  const same = (left: unknown, right: unknown) => JSON.stringify(left) === JSON.stringify(right);

  const kernel = new KernelClient();
  const pathLookupsStarted = new Set<string>();
  const lookupAbort = new AbortController();
  let resolvedHPaths = $state<Record<string, string>>({});

  async function resolveHPath(id: string, signal: AbortSignal): Promise<void> {
    if (signal.aborted || resolvedHPaths[id]) return;
    try {
      const title = await resolveDocumentTitle(kernel, id, {
        signal,
        endpoints: ["/api/filetree/getFullHPathByID", "/api/filetree/getHPathByID"],
      });
      if (!signal.aborted && title && title !== id) {
        resolvedHPaths[id] = title;
      }
    } catch {
      // Fallback: leave unresolved so meta.title or id is used
    }
  }

  async function resolveHPathBatch(ids: string[], signal: AbortSignal): Promise<void> {
    const concurrency = 4;
    let next = 0;
    const worker = async () => {
      while (next < ids.length && !signal.aborted) {
        const id = ids[next++];
        await resolveHPath(id, signal);
      }
    };
    await Promise.all(Array.from({ length: Math.min(concurrency, ids.length) }, () => worker()));
  }

  $effect(() => {
    const allowlist = draft.auto.pageAllowlist;
    untrack(() => {
      const pending: string[] = [];
      for (const [id, meta] of Object.entries(allowlist)) {
        if (meta.title && meta.title.includes("/")) {
          resolvedHPaths[id] = meta.title;
          pathLookupsStarted.add(id);
        } else if (!resolvedHPaths[id] && !pathLookupsStarted.has(id)) {
          pathLookupsStarted.add(id);
          pending.push(id);
        }
      }
      if (pending.length > 0 && !lookupAbort.signal.aborted) {
        void resolveHPathBatch(pending, lookupAbort.signal);
      }
    });
  });

  const initial = untrack(() => copy(store.snapshot()));
  let baseline = $state<ImageFeatureConfig>(initial);
  let draft = $state<ImageFeatureConfig>(copy(initial));
  let rootID = $state("");
  let search = $state("");
  let busy = $state(false);
  let conflict = $state(false);
  let readOnly = $state(untrack(() => store.needsRecovery));
  let error = $state("");
  let notice = $state("");
  let dirty = $derived(!same(draft, baseline));
  let permissionRows = $derived(Object.entries(draft.auto.pageAllowlist)
    .filter(([id, meta]) => {
      const displayTitle = resolvedHPaths[id] || meta.title || id;
      return `${id} ${displayTitle}`.toLocaleLowerCase().includes(search.toLocaleLowerCase());
    }));

  function adopt(value: Readonly<ImageFeatureConfig>) {
    const next = copy(value as ImageFeatureConfig);
    baseline = next;
    draft = copy(next);
    conflict = false;
    error = "";
    notice = "";
  }

  onMount(() => {
    const unsubscribe = store.subscribe(value => {
      readOnly = store.needsRecovery;
      if (!dirty) adopt(value);
      else if (!same(value, baseline)) conflict = true;
    });
    return () => {
      unsubscribe();
      lookupAbort.abort();
    };
  });

  function resetDraft() {
    const value = defaultImageFeatureConfig();
    draft = copy(value);
    error = "";
    notice = "";
  }

  async function save(event: SubmitEvent) {
    event.preventDefault();
    if (busy || readOnly || conflict || !dirty) return;
    busy = true;
    error = "";
    notice = "";
    try {
      const plain = $state.snapshot(draft);
      const next = parseImageConfig(plain);
      const expected = $state.snapshot(baseline);
      await store.update(current => {
        if (!same(current, expected)) throw new SettingsConflictError(t("settings.concurrentChange"));
        Object.assign(current, next);
      });
      adopt(store.snapshot());
      notice = t("settings.saved");
    } catch (cause) {
      if (isSettingsConflictError(cause)) {
        conflict = true;
        error = t("settings.concurrentChange");
      } else {
        error = describeError(cause);
      }
    } finally {
      busy = false;
    }
  }

  async function addDocument() {
    const id = rootID.trim();
    if (!NODE_ID.test(id)) { error = t("settings.invalidDocument"); return; }
    busy = true;
    error = "";
    try {
      const verified = await validateDocument(id);
      if (verified.id !== id) throw new Error(t("settings.invalidDocument"));
      if (!Object.hasOwn(draft.auto.pageAllowlist, id)) {
        draft.auto.pageAllowlist[id] = { grantedAt: Date.now(), title: verified.title };
        if (verified.title) resolvedHPaths[id] = verified.title;
      }
      rootID = "";
    } catch (cause) {
      error = describeError(cause);
    } finally {
      busy = false;
    }
  }

  async function recoverSettings() {
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

  function validateDraft(): string {
    try {
      const plain = $state.snapshot(draft);
      parseImageConfig(plain);
      return "";
    } catch (cause) { return describeError(cause); }
  }

  let validationError = $derived(dirty ? validateDraft() : "");
</script>

<form class="omnikit-image-settings" onsubmit={save}>
  {#if readOnly}
    <div class="notice notice--error" role="alert">
      <strong>{t("recovery.settingsWarning")}</strong>
      <button type="button" class="b3-button b3-button--outline" disabled={busy} onclick={recoverSettings}>
        {t("recovery.settingsButton")}
      </button>
    </div>
  {/if}
  {#if runtimePhase !== "enabled" && runtimePhase !== "configured"}<div class="notice">{t("settings.disabledButEditable")}</div>{/if}

  <div class="capabilities"><span>{t("settings.host")}: {hostVersion}</span></div>

  <fieldset disabled={busy || readOnly}>
    <section class="setting-card">
      <header><h3>{t("settings.authorization")}</h3><p>{t("settings.authorizationHelp")}</p></header>
      <label class="setting-row">
        <span><strong>{t("settings.global")}</strong><small>{t("settings.globalHelp")}</small></span>
        <input type="checkbox" class="b3-switch" bind:checked={draft.auto.globalEnabled} />
      </label>
    </section>

    <section class="setting-card">
      <header><h3>{t("settings.quality")}</h3><p>{t("settings.qualityHelp")}</p></header>
      <label class="setting-row">
        <span><strong>{t("settings.smartEnabled")}</strong><small>{t("settings.smartEnabledHelp")}</small></span>
        <input type="checkbox" class="b3-switch" bind:checked={draft.compression.smartEnabled} />
      </label>
      {#if draft.compression.smartEnabled}
        <label class="setting-row">
          <span><strong>{t("settings.targetSimilarity")}</strong><small>{t("settings.targetSimilarityHelp")}</small></span>
          <span class="range-control">
            <input type="range" min="0.90" max="0.999" step="0.001" bind:value={draft.compression.targetSimilarity}
              aria-label={t("settings.targetSimilarity")} />
            <output>{(draft.compression.targetSimilarity * 100).toFixed(1)}%</output>
          </span>
        </label>
      {/if}
      <label class="setting-row">
        <span><strong>{t("settings.initialQuality")}</strong><small>{t("settings.notSimilarity")}</small></span>
        <span class="range-control">
          <input type="range" min="0.01" max="1" step="0.01" bind:value={draft.compression.initialQuality}
            aria-label={t("settings.initialQuality")} />
          <output>{Math.round(draft.compression.initialQuality * 100)}%</output>
        </span>
      </label>
      <label class="setting-row">
        <span><strong>{t("settings.manualMaxEdge")}</strong><small>{t("settings.manualMaxEdgeHelp")}</small></span>
        <span class="number-control"><input type="number" class="b3-text-field" min="512" max="16384" step="1"
          bind:value={draft.compression.manualMaxEdge} /><span>px</span></span>
      </label>
    </section>

    <!-- preserveExif remains in the settings schema, default false; hidden until encoder supports it. -->

    <section class="setting-card">
      <header><h3>{t("settings.documents")} · {Object.keys(draft.auto.pageAllowlist).length}</h3>
        <p>{t("settings.documentsHelp")}</p></header>
      <div class="document-controls">
        <input class="b3-text-field" bind:value={search} placeholder={t("settings.searchDocuments")}
          aria-label={t("settings.searchDocuments")} />
        <input class="b3-text-field" bind:value={rootID} placeholder={t("settings.documentID")}
          aria-label={t("settings.documentID")} />
        <button type="button" class="b3-button b3-button--outline" disabled={busy || readOnly || conflict}
          onclick={addDocument}>{t("settings.add")}</button>
      </div>
      <div class="document-list">
        {#each permissionRows as [id, meta] (id)}
          {@const displayTitle = resolvedHPaths[id] || meta.title || id}
          <div class="document-row">
            <span><strong>{displayTitle}</strong><small>{id}</small></span>
            <button type="button" class="b3-button b3-button--text" disabled={conflict}
              onclick={() => delete draft.auto.pageAllowlist[id]}
              aria-label={`${t("settings.remove")} ${displayTitle}`}>{t("settings.remove")}</button>
          </div>
        {:else}<p class="footnote">{t("settings.noDocuments")}</p>{/each}
      </div>
    </section>

  </fieldset>

  {#if conflict}
    <div class="notice notice--error" role="alert">
      {t("settings.concurrentChange")}
      <button type="button" class="b3-button b3-button--outline" onclick={() => adopt(store.snapshot())}>
        {t("settings.discardReload")}
      </button>
    </div>
  {/if}
  {#if error}<p class="warning" role="alert">{error}</p>{/if}
  {#if validationError}<p class="warning" role="alert">{validationError}</p>{/if}
  <div class="save-bar-container">
    <footer class="save-bar" class:save-bar--dirty={dirty} class:save-bar--busy={busy}>
      <div class="save-bar__status" aria-live="polite">
        <span
          class="status-dot"
          class:status-dot--saved={!dirty && !busy}
          class:status-dot--dirty={dirty && !busy}
          class:status-dot--busy={busy}></span>
        <span class="status-text">{notice || t(busy ? "settings.saving" : dirty ? "settings.unsaved" : "settings.saved")}</span>
      </div>
      <div class="save-bar__actions">
        <button
          type="button"
          class="bar-btn bar-btn--ghost"
          disabled={busy || readOnly}
          onclick={resetDraft}>
          {t("settings.resetDraft")}
        </button>
        <button
          type="submit"
          class="bar-btn bar-btn--primary"
          disabled={busy || readOnly || conflict || !dirty || !!validationError}>
          {t("settings.save")}
        </button>
      </div>
    </footer>
  </div>
</form>

<style>
  .omnikit-image-settings { color: var(--b3-theme-on-background); max-width: 940px; margin: auto; }
  fieldset { border: 0; padding: 0; margin: 0; min-width: 0; display: grid; gap: 16px; }
  .setting-card { border: 1px solid var(--b3-border-color); border-radius: 8px; padding: 16px 20px; }
  header { margin-bottom: 8px; } h3 { font-size: 15px; margin: 0 0 6px; }
  p, small, .footnote { color: var(--b3-theme-on-surface); line-height: 1.6; }
  p { margin: 4px 0; } small { display: block; font-size: 12px; margin-top: 4px; }
  .setting-row { display: grid; grid-template-columns: minmax(0,1fr) auto; gap: 24px; align-items: center; padding: 14px 0; }
  .setting-row + .setting-row { border-top: 1px solid var(--b3-border-color); }
  .range-control { display: flex; align-items: center; gap: 12px; width: 220px; }
  .range-control input { width: 160px; accent-color: var(--b3-theme-primary); }
  output { min-width: 40px; text-align: right; font-variant-numeric: tabular-nums; }
  .number-control { display: flex; align-items: center; gap: 8px; }
  .number-control input { width: 104px; }
  .notice { background: var(--b3-theme-surface); border-radius: 6px; padding: 12px; margin: 8px 0 16px; line-height: 1.6; }
  .notice--error { border-inline-start: 3px solid var(--b3-theme-error); }
  .warning { color: var(--b3-theme-error); }
  .capabilities { display: flex; flex-wrap: wrap; gap: 8px 20px; margin-bottom: 16px; color: var(--b3-theme-on-surface); font-size: 12px; }
  .document-controls { display: flex; flex-wrap: wrap; gap: 8px; }
  .document-controls input { flex: 1 1 180px; min-width: 0; }
  .document-list { max-height: 240px; overflow: auto; margin-top: 12px; }
  .document-row { display: flex; align-items: center; justify-content: space-between; gap: 12px; padding: 10px 0; }
  .document-row span { min-width: 0; } .document-row strong { display: block; overflow: hidden; text-overflow: ellipsis; }

  /* Floating Capsule Save Bar */
  .save-bar-container {
    position: sticky;
    bottom: 16px;
    z-index: 50;
    display: flex;
    justify-content: center;
    margin-top: 32px;
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
  }
  .save-bar:hover {
    box-shadow: var(--b3-dialog-shadow, 0 14px 36px -4px color-mix(in srgb, var(--b3-theme-on-background) 22%, transparent));
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
  }
  .bar-btn:active:not(:disabled) {
    transform: scale(0.97);
  }
  .bar-btn--ghost {
    background: transparent;
    color: var(--b3-theme-on-surface);
    border: 1px solid transparent;
  }
  .bar-btn--ghost:hover:not(:disabled) {
    background: var(--b3-theme-surface-lighter);
    color: var(--b3-theme-on-background);
  }
  .bar-btn--ghost:disabled {
    opacity: 0.4;
    cursor: not-allowed;
  }
  .bar-btn--primary {
    background: var(--b3-theme-primary);
    color: var(--b3-theme-on-primary);
    box-shadow: 0 2px 8px color-mix(in srgb, var(--b3-theme-primary) 35%, transparent);
  }
  .bar-btn--primary:hover:not(:disabled) {
    filter: brightness(1.08);
    box-shadow: 0 4px 14px color-mix(in srgb, var(--b3-theme-primary) 45%, transparent);
    transform: translateY(-0.5px);
  }
  .bar-btn--primary:disabled {
    background: var(--b3-theme-surface-lighter);
    color: var(--b3-theme-on-surface);
    opacity: 0.5;
    box-shadow: none;
    cursor: not-allowed;
  }
  @keyframes omnikit-pulse {
    0%, 100% { opacity: 1; transform: scale(1); }
    50% { opacity: 0.45; transform: scale(0.85); }
  }

  @media (max-width: 620px) {
    .setting-card { padding: 12px; } .setting-row { gap: 12px; }
    .setting-row:has(.range-control) { grid-template-columns: 1fr; }
    .range-control { width: 100%; } .range-control input { flex: 1; }
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
