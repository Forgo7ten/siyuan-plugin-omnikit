<script lang="ts">
  import { onMount, untrack } from "svelte";
  import { isAbortError } from "../../../core/feedback/UiFeedback.ts";
  import type { FeaturePhase } from "../../../core/framework/BaseFeature.ts";
  import { describeError } from "../../../core/host/describeError.ts";
  import { KernelClient } from "../../../core/host/KernelClient.ts";
  import { Logger } from "../../../core/host/Logger.ts";
  import type { JsonStore } from "../../../core/store/JsonStore.ts";
  import { SettingsConflictError, isSettingsConflictError } from "../../../core/store/SettingsConflictError.ts";
  import type { RegisterDraftParticipant } from "../../../ui/settings/DraftParticipant.ts";
  import type { ImageFeatureConfig } from "../policy/parseImageConfig.ts";
  import { defaultImageFeatureConfig, NODE_ID, parseImageConfig } from "../policy/parseImageConfig.ts";
  import { IMAGE_FEATURE_ID } from "../policy/settings.ts";
  import { resolveAllowlistPaths } from "../services/allowlistPaths.ts";

  interface Props {
    store: JsonStore<ImageFeatureConfig>;
    runtimePhase: FeaturePhase | "configured";
    hostVersion: string;
    desktopFrontend?: boolean;
    t: (key: string, values?: Record<string, string | number>) => string;
    validateDocument: (rootID: string) => Promise<{ id: string }>;
    registerDraft?: RegisterDraftParticipant;
    globalSaving?: boolean;
  }
  let {
    store,
    runtimePhase,
    hostVersion,
    desktopFrontend = false,
    t,
    validateDocument,
    registerDraft,
    globalSaving = false,
  }: Props = $props();
  const copy = (value: ImageFeatureConfig): ImageFeatureConfig => JSON.parse(JSON.stringify(value)) as ImageFeatureConfig;
  const same = (left: unknown, right: unknown) => JSON.stringify(left) === JSON.stringify(right);

  const kernel = new KernelClient();
  const pathLookupsStarted = new Set<string>();
  const lookupAbort = new AbortController();
  let resolvedHPaths = $state<Record<string, string>>({});

  $effect(() => {
    const ids = Object.keys(draft.auto.pageAllowlist);
    const activeIds = new Set(ids);
    untrack(() => {
      for (const id of [...pathLookupsStarted]) {
        if (!activeIds.has(id)) {
          pathLookupsStarted.delete(id);
        }
      }
      let pruned = false;
      const nextResolved: Record<string, string> = { ...resolvedHPaths };
      for (const id of Object.keys(nextResolved)) {
        if (!activeIds.has(id)) {
          delete nextResolved[id];
          pruned = true;
        }
      }
      if (pruned) {
        resolvedHPaths = nextResolved;
      }

      const pending: string[] = [];
      for (const id of ids) {
        if (!resolvedHPaths[id] && !pathLookupsStarted.has(id)) {
          pathLookupsStarted.add(id);
          pending.push(id);
        }
      }
      if (pending.length > 0 && !lookupAbort.signal.aborted) {
        void resolveAllowlistPaths(kernel, pending, {
          signal: lookupAbort.signal,
          logger: Logger.shared,
        })
          .then(resolved => {
            if (lookupAbort.signal.aborted) {
              for (const id of pending) pathLookupsStarted.delete(id);
              return;
            }
            const currentIds = new Set(Object.keys(draft.auto.pageAllowlist));
            const merged: Record<string, string> = { ...resolvedHPaths };
            let changed = false;
            for (const id of pending) {
              if (!currentIds.has(id) || !Object.hasOwn(resolved, id)) {
                pathLookupsStarted.delete(id);
                continue;
              }
              if (merged[id] !== resolved[id]) {
                merged[id] = resolved[id];
                changed = true;
              }
            }
            if (changed) {
              resolvedHPaths = merged;
            }
          })
          .catch(cause => {
            for (const id of pending) {
              pathLookupsStarted.delete(id);
            }
            if (!lookupAbort.signal.aborted && !isAbortError(cause)) {
              Logger.shared.debug("白名单路径批量解析失败", cause);
            }
          });
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
    .filter(([id]) => {
      const displayTitle = resolvedHPaths[id] || id;
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

  function resetDraft() {
    draft = copy(defaultImageFeatureConfig());
    error = "";
    notice = "";
  }

  async function save(): Promise<void> {
    if (readOnly || conflict) return;
    error = "";
    notice = "";
    try {
      const plain = $state.snapshot(draft);
      const next = parseImageConfig(plain);
      const expected = $state.snapshot(baseline);
      await store.update(current => {
        if (!same(current, expected)) {
          throw new SettingsConflictError(t("settings.concurrentChange"));
        }
        Object.assign(current, next);
      });
      adopt(store.snapshot());
    } catch (cause) {
      if (isSettingsConflictError(cause)) {
        conflict = true;
        error = t("settings.concurrentChange");
      } else {
        error = describeError(cause);
      }
      throw cause;
    }
  }

  onMount(() => {
    const unsubscribe = store.subscribe(value => {
      readOnly = store.needsRecovery;
      const isDirty = !same($state.snapshot(draft), $state.snapshot(baseline));
      if (!isDirty) adopt(value);
      else if (!same(value, $state.snapshot(baseline))) conflict = true;
    });
    const unregisterDraft = registerDraft?.({
      id: IMAGE_FEATURE_ID,
      isDirty: () => !same($state.snapshot(draft), $state.snapshot(baseline)),
      validate: () => {
        parseImageConfig($state.snapshot(draft));
      },
      save,
      resetToDefaults: resetDraft,
      isReadOnly: () => readOnly,
      hasConflict: () => conflict,
    });
    return () => {
      unregisterDraft?.();
      unsubscribe();
      lookupAbort.abort();
    };
  });

  async function addDocument() {
    if (busy || globalSaving || readOnly || conflict) return;
    const id = rootID.trim();
    if (!NODE_ID.test(id)) { error = t("settings.invalidDocument"); return; }
    busy = true;
    error = "";
    try {
      const verified = await validateDocument(id);
      if (verified.id !== id) throw new Error(t("settings.invalidDocument"));
      if (globalSaving || readOnly || conflict) return;
      if (!Object.hasOwn(draft.auto.pageAllowlist, id)) {
        draft.auto.pageAllowlist[id] = { grantedAt: Date.now() };
      }
      rootID = "";
    } catch (cause) {
      error = describeError(cause);
    } finally {
      busy = false;
    }
  }

  async function recoverSettings() {
    if (busy || globalSaving) return;
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

<div class="omnikit-image-settings" data-desktop-frontend={desktopFrontend ? "true" : undefined}>
  {#if readOnly}
    <div class="notice notice--error" role="alert">
      <strong>{t("recovery.settingsWarning")}</strong>
      <button type="button" class="b3-button b3-button--outline" disabled={busy || globalSaving} onclick={recoverSettings}>
        {t("recovery.settingsButton")}
      </button>
    </div>
  {/if}
  {#if runtimePhase !== "enabled" && runtimePhase !== "configured"}<div class="notice">{t("settings.disabledButEditable")}</div>{/if}

  <div class="capabilities"><span>{t("settings.host")}: {hostVersion}</span></div>

  <fieldset disabled={busy || globalSaving || readOnly}>
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
        <button type="button" class="b3-button b3-button--outline" disabled={busy || globalSaving || readOnly || conflict}
          onclick={addDocument}>{t("settings.add")}</button>
      </div>
      <div class="document-list">
        {#each permissionRows as [id] (id)}
          {@const displayTitle = resolvedHPaths[id] || id}
          <div class="document-row">
            <span><strong>{displayTitle}</strong><small>{id}</small></span>
            <button type="button" class="b3-button b3-button--text" disabled={busy || globalSaving || readOnly || conflict}
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
      <button type="button" class="b3-button b3-button--outline" disabled={busy || globalSaving} onclick={() => adopt(store.snapshot())}>
        {t("settings.discardReload")}
      </button>
    </div>
  {/if}
  {#if error}<p class="warning" role="alert">{error}</p>{/if}
  {#if validationError}<p class="warning" role="alert">{validationError}</p>{/if}
  {#if notice}<p class="notice" role="status">{notice}</p>{/if}
</div>

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

  @media (max-width: 620px) {
    .setting-card { padding: 12px; } .setting-row { gap: 12px; }
    .setting-row:has(.range-control) { grid-template-columns: 1fr; }
    .range-control { width: 100%; } .range-control input { flex: 1; }
  }
</style>
