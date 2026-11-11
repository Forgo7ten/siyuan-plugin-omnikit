<script lang="ts">
  import { onMount, untrack } from "svelte";
  import { getActiveEditor, showMessage } from "siyuan";
  import type { JsonStore } from "../../core/JsonStore.ts";
  import type { ImageFeatureConfig } from "./registration.ts";
  import { AssetRepository } from "./AssetRepository.ts";
  import { isDocumentRootIdentity } from "./DocumentIdentity.ts";
  import { parseExcludedExtensions } from "./ExcludedExtensions.ts";

  interface Props {
    store: JsonStore<ImageFeatureConfig>;
    disabled: boolean;
    t: (key: string) => string;
  }
  let { store, disabled, t }: Props = $props();
  let config = $state<ImageFeatureConfig>(untrack(() => store.snapshot()));
  let saving = $state(false);
  let error = $state("");
  let manualRootID = $state("");
  let excludedExtensions = $state(untrack(() => store.snapshot().compression.excludedExtensions));

  onMount(() => store.subscribe(value => {
    config = value as ImageFeatureConfig;
    excludedExtensions = config.compression.excludedExtensions;
  }));

  async function change(mutator: (draft: ImageFeatureConfig) => void) {
    if (disabled || saving) return;
    saving = true;
    error = "";
    try { await store.update(mutator); }
    catch (cause) { error = String(cause); }
    finally { saving = false; }
  }

  async function addDocument(rootID: string) {
    if (!rootID || disabled || saving) return;
    saving = true;
    error = "";
    try {
      const repository = new AssetRepository();
      const identity = await repository.getBlockIdentity(rootID);
      if (!isDocumentRootIdentity(identity, rootID)) {
        throw new Error(t("menu.notDocument"));
      }
      await store.update(draft => {
        if (!draft.autoCompression.pageAllowlist[rootID]) {
          draft.autoCompression.pageAllowlist[rootID] = {
            grantedAt: Date.now(),
            notebookIdSnapshot: typeof identity?.box === "string" ? identity.box : undefined,
          };
        }
      });
      manualRootID = "";
    } catch (cause) { error = String(cause); }
    finally { saving = false; }
  }

  async function addCurrent() {
    const rootID = (getActiveEditor() as any)?.protyle?.block?.rootID as string | undefined;
    if (!rootID) {
      showMessage(t("allowlist.currentMissing"), 4000, "error");
      return;
    }
    await addDocument(rootID);
  }

  async function recoverSettings() {
    if (saving) return;
    saving = true;
    error = "";
    try { await store.recoverWithBackup(); }
    catch (cause) { error = String(cause); }
    finally { saving = false; }
  }
</script>

<section class="omnikit-feature-settings">
  {#if store.needsRecovery}
    <p class="omnikit-error" role="alert">{store.error}</p>
    <button class="b3-button" disabled={saving} onclick={recoverSettings}>
      {t("recovery.settingsButton")}
    </button>
  {/if}

  <h3>{t("auto.scopeTitle")}</h3>
  <label class="b3-label omnikit-control">
    <span>
      <strong>{t("auto.globalEnabled")}</strong>
      <small>{t("auto.globalDescription")}</small>
    </span>
    <input type="checkbox" class="b3-switch"
      disabled={disabled || saving || store.needsRecovery}
      checked={config.autoCompression.globalEnabled}
      onchange={e => {
        const checked = e.currentTarget.checked;
        void change(draft => { draft.autoCompression.globalEnabled = checked; });
      }} />
  </label>

  <p class="ft__smaller">{config.autoCompression.globalEnabled
    ? t("auto.globalScopeHint")
    : t("auto.allowlistScopeHint")}</p>

  <h3>{t("allowlist.title")}</h3>
  <div class="fn__flex omnikit-allowlist-actions">
    <button class="b3-button" disabled={disabled || saving} onclick={addCurrent}>
      {t("allowlist.addCurrent")}
    </button>
    <input class="b3-text-field fn__flex-1" placeholder={t("allowlist.rootId")}
      bind:value={manualRootID} disabled={disabled || saving} />
    <button class="b3-button" disabled={disabled || saving || !manualRootID.trim()}
      onclick={() => addDocument(manualRootID.trim())}>{t("allowlist.grant")}</button>
  </div>
  <ul class="b3-list omnikit-allowlist">
    {#each Object.entries(config.autoCompression.pageAllowlist) as [rootID, meta] (rootID)}
      <li class="b3-list-item">
        <span class="fn__flex-1">
          <strong>{meta.titleSnapshot || rootID}</strong>
          <small>{rootID}</small>
        </span>
        <button class="b3-button b3-button--outline" disabled={disabled || saving}
          onclick={() => change(draft => { delete draft.autoCompression.pageAllowlist[rootID]; })}>
          {t("allowlist.revoke")}
        </button>
      </li>
    {/each}
  </ul>

  <h3>{t("compression.title")}</h3>
  <label class="b3-label omnikit-control">
    <span>{t("quality")}</span>
    <input type="number" class="b3-text-field" min="0.1" max="1" step="0.05"
      disabled={disabled || saving} value={config.compression.quality}
      onchange={e => {
        const value = Number(e.currentTarget.value);
        void change(draft => { draft.compression.quality = value; });
      }} />
  </label>
  <label class="b3-label omnikit-control">
    <span>{t("maxDimension")}</span>
    <input type="number" class="b3-text-field" min="256" max="8192" step="128"
      disabled={disabled || saving} value={config.compression.maxDimension}
      onchange={e => {
        const value = Number(e.currentTarget.value);
        void change(draft => { draft.compression.maxDimension = value; });
      }} />
  </label>
  <label class="b3-label omnikit-control">
    <span>{t("excludedExtensions")}</span>
    <input class="b3-text-field" bind:value={excludedExtensions} disabled={disabled || saving}
      onblur={() => {
        const parsed = parseExcludedExtensions(excludedExtensions);
        if (!parsed.ok) { error = t("excludedExtensions.invalid").replace("{token}", parsed.token); return; }
        excludedExtensions = parsed.value;
        void change(draft => { draft.compression.excludedExtensions = parsed.value; });
      }} />
  </label>
  <p class="ft__smaller">{t("excludedExtensions.description")}</p>

  {#if error}<p class="omnikit-error" role="alert">{error}</p>{/if}
</section>

<style lang="scss">
  .omnikit-control { display: flex; align-items: center; justify-content: space-between; gap: 1rem; }
  .omnikit-control > span { display: flex; flex-direction: column; gap: 0.25rem; }
  .omnikit-control input[type="number"] { width: 7rem; flex-shrink: 0; }
  .omnikit-allowlist-actions { gap: .5rem; flex-wrap: wrap; }
  .omnikit-allowlist li { display: flex; justify-content: space-between; align-items: center; gap: .5rem; }
  .omnikit-allowlist small { display: block; color: var(--b3-theme-on-surface-light); }
  .omnikit-error { color: var(--b3-theme-error); }
</style>
