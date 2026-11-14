<script lang="ts">
  import { onMount, untrack } from "svelte";
  import type { JsonStore } from "../../core/JsonStore.ts";
  import type { ImageFeatureConfig } from "./parseImageConfig.ts";
  import { defaultImageFeatureConfig, NODE_ID, parseImageConfig } from "./parseImageConfig.ts";
  import { KernelClient } from "../../core/KernelClient.ts";

  interface Props {
    store: JsonStore<ImageFeatureConfig>;
    runtimePhase: string;
    hostVersion: string;
    desktopFrontend: boolean;
    t: (key: string) => string;
    validateDocument: (rootID: string) => Promise<{ id: string; title: string }>;
  }
  let { store, runtimePhase, hostVersion, desktopFrontend, t, validateDocument }: Props = $props();
  const copy = (value: ImageFeatureConfig): ImageFeatureConfig => JSON.parse(JSON.stringify(value)) as ImageFeatureConfig;
  const same = (left: unknown, right: unknown) => JSON.stringify(left) === JSON.stringify(right);

  const kernel = new KernelClient();
  let resolvedHPaths = $state<Record<string, string>>({});

  async function resolveHPath(id: string): Promise<void> {
    if (resolvedHPaths[id]) return;
    try {
      const res = await kernel.post<string>("/api/filetree/getFullHPathByID", { id });
      if (typeof res.data === "string" && res.data.trim()) {
        resolvedHPaths[id] = res.data.trim();
        return;
      }
    } catch {
      try {
        const fallback = await kernel.post<string>("/api/filetree/getHPathByID", { id });
        if (typeof fallback.data === "string" && fallback.data.trim()) {
          resolvedHPaths[id] = fallback.data.trim();
        }
      } catch {
        // Fallback: leave unresolved so meta.title or id is used
      }
    }
  }

  $effect(() => {
    for (const [id, meta] of Object.entries(draft.auto.pageAllowlist)) {
      if (meta.title && meta.title.includes("/")) {
        resolvedHPaths[id] = meta.title;
      } else if (!resolvedHPaths[id]) {
        void resolveHPath(id);
      }
    }
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

  onMount(() => store.subscribe(value => {
    readOnly = store.needsRecovery;
    if (!dirty) adopt(value);
    else if (!same(value, baseline)) conflict = true;
  }));

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
        if (!same(current, expected)) throw new Error(t("settings.concurrentChange"));
        Object.assign(current, next);
      });
      adopt(store.snapshot());
      notice = t("settings.saved");
    } catch (cause) {
      error = cause instanceof Error ? cause.message : String(cause);
      if (error.includes(t("settings.concurrentChange"))) conflict = true;
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
      error = cause instanceof Error ? cause.message : String(cause);
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
      error = `${t("recovery.settingsFailed")} ${cause instanceof Error ? cause.message : String(cause)}`;
    } finally {
      busy = false;
    }
  }

  function validateDraft(): string {
    try {
      const plain = $state.snapshot(draft);
      parseImageConfig(plain);
      return "";
    } catch (cause) { return cause instanceof Error ? cause.message : String(cause); }
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
  {#if runtimePhase !== "enabled"}<div class="notice">{t("settings.disabledButEditable")}</div>{/if}

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

    <section class="setting-card">
      <header><h3>{t("settings.metadata")}</h3></header>
      <label class="setting-row">
        <span><strong>{t("settings.preserveExif")}</strong><small>{t("settings.exifUnavailable")}</small></span>
        <input type="checkbox" class="b3-switch" checked={draft.metadata.preserveExif} disabled />
      </label>
    </section>

    <section class="setting-card">
      <header><h3>{t("settings.userAgent")}</h3><p>{t("settings.userAgentHelp")}</p></header>
      <label class="setting-row">
        <span><strong>{t("settings.userAgent")}</strong><small>{t(desktopFrontend ? "settings.userAgentDesktopOnly" : "settings.userAgentUnavailable")}</small></span>
        <input class="b3-text-field text-control" maxlength="256" bind:value={draft.remote.downloadUserAgent}
          disabled={!desktopFrontend} aria-label={t("settings.userAgent")} />
      </label>
    </section>

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
  .number-control input { width: 104px; } .text-control { width: 220px; }
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
    box-shadow: 0 10px 28px -4px rgba(0, 0, 0, 0.16), 0 2px 8px -2px rgba(0, 0, 0, 0.08);
    transition: all 0.25s cubic-bezier(0.16, 1, 0.3, 1);
  }
  .save-bar:hover {
    box-shadow: 0 14px 36px -4px rgba(0, 0, 0, 0.22), 0 4px 12px -2px rgba(0, 0, 0, 0.1);
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
    background: #10b981;
    box-shadow: 0 0 6px rgba(16, 185, 129, 0.5);
  }
  .status-dot--dirty {
    background: #f59e0b;
    box-shadow: 0 0 8px rgba(245, 158, 11, 0.6);
    animation: omnikit-pulse 2s infinite ease-in-out;
  }
  .status-dot--busy {
    background: var(--b3-theme-primary);
    box-shadow: 0 0 8px rgba(var(--b3-theme-primary-rgb, 66, 133, 244), 0.6);
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
    background: var(--b3-theme-surface-lighter, rgba(125, 125, 125, 0.12));
    color: var(--b3-theme-on-background);
  }
  .bar-btn--ghost:disabled {
    opacity: 0.4;
    cursor: not-allowed;
  }
  .bar-btn--primary {
    background: var(--b3-theme-primary);
    color: #ffffff;
    box-shadow: 0 2px 8px rgba(var(--b3-theme-primary-rgb, 66, 133, 244), 0.35);
  }
  .bar-btn--primary:hover:not(:disabled) {
    filter: brightness(1.08);
    box-shadow: 0 4px 14px rgba(var(--b3-theme-primary-rgb, 66, 133, 244), 0.45);
    transform: translateY(-0.5px);
  }
  .bar-btn--primary:disabled {
    background: var(--b3-theme-surface-lighter, rgba(125, 125, 125, 0.15));
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
    .setting-row:has(.range-control), .setting-row:has(.text-control) { grid-template-columns: 1fr; }
    .range-control, .text-control { width: 100%; } .range-control input { flex: 1; }
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
