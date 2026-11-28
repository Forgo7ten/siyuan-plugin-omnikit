<script lang="ts">
  import { onMount, untrack } from "svelte";
  import type { FeatureRegistration } from "../../core/framework/FeatureRegistration.ts";
  import { DEFAULT_USER_AGENT, type SettingsManager, type CoreSettings } from "../../core/store/SettingsManager.ts";
  import type { FeatureManager, FeatureStatus } from "../../core/framework/FeatureManager.ts";
  import { SettingsConflictError, isSettingsConflictError } from "../../core/store/SettingsConflictError.ts";
  import { isFrontendSupported } from "../../core/host/Platform.ts";
  import { describeError } from "../../core/host/describeError.ts";
  import { Logger } from "../../core/host/Logger.ts";
  import type { DraftParticipant, RegisterDraftParticipant } from "./DraftParticipant.ts";
  import SettingsSidebar from "./SettingsSidebar.svelte";
  import GeneralSettingsCard from "./GeneralSettingsCard.svelte";
  import FeatureSettingsCard from "./FeatureSettingsCard.svelte";
  import SettingsSaveBar from "./SettingsSaveBar.svelte";

  interface Props {
    registrations: readonly FeatureRegistration<any>[];
    settings: SettingsManager;
    manager?: FeatureManager;
    t: (key: string, values?: Record<string, string | number>) => string;
  }

  let { registrations, settings, manager, t }: Props = $props();

  const copy = (value: CoreSettings): CoreSettings => JSON.parse(JSON.stringify(value)) as CoreSettings;
  const same = (left: unknown, right: unknown): boolean => JSON.stringify(left) === JSON.stringify(right);

  const initialCore = untrack(() => copy(settings.core.snapshot()));
  let coreBaseline = $state<CoreSettings>(initialCore);
  let coreDraft = $state<CoreSettings>(copy(initialCore));
  let coreRecovery = $state(untrack(() => settings.core.needsRecovery));
  let coreConflict = $state(false);

  let featureRecovery = $state<Record<string, boolean>>(
    untrack(() => Object.fromEntries(registrations.map(entry => [entry.id, settings.store(entry.id).needsRecovery]))),
  );
  let participants = $state.raw<Record<string, DraftParticipant>>({});

  let activeId = $state("general");
  let globalSaving = $state(false);
  let error = $state("");
  let notice = $state("");
  let runtimeStatuses = $state<FeatureStatus[]>(untrack(() => manager?.statuses() ?? []));

  let coreDirty = $derived(!same(coreDraft, coreBaseline));
  let participantList = $derived(Object.values(participants));
  let anyDirty = $derived(
    (!coreRecovery && coreDirty) || participantList.some(participant => !participant.isReadOnly() && participant.isDirty()),
  );
  let hasAnyConflict = $derived(
    (!coreRecovery && coreConflict) || participantList.some(participant => !participant.isReadOnly() && participant.hasConflict()),
  );
  let allReadOnly = $derived(
    coreRecovery && (participantList.length === 0 || participantList.every(participant => participant.isReadOnly())),
  );
  let statusText = $derived(
    globalSaving
      ? t("settings.saving")
      : anyDirty
        ? t("settings.unsaved")
        : (notice || t("settings.saved")),
  );

  let scrollerEl: HTMLElement | undefined;
  const sectionMap: Record<string, HTMLElement> = {};
  let isProgrammaticScroll = false;
  let scrollTimeout: ReturnType<typeof setTimeout> | undefined;

  function setSectionRef(id: string, el: HTMLElement | undefined): void {
    if (el) sectionMap[id] = el;
    else delete sectionMap[id];
  }

  const registerDraft: RegisterDraftParticipant = participant => {
    participants = { ...participants, [participant.id]: participant };
    return () => {
      if (participants[participant.id] !== participant) return;
      const next = { ...participants };
      delete next[participant.id];
      participants = next;
    };
  };

  function adoptCore(value: Readonly<CoreSettings>): void {
    const next = copy(value as CoreSettings);
    coreBaseline = next;
    coreDraft = copy(next);
    coreConflict = false;
  }

  onMount(() => {
    const disposeCore = settings.core.subscribe(value => {
      coreRecovery = settings.core.needsRecovery;
      // @safety Do not clobber a field the user has modified or is actively editing.
      const editingUserAgent = typeof document !== "undefined" &&
        (document.activeElement as HTMLElement | null)?.getAttribute?.("data-omnikit-field") === "user-agent";
      const dirty = !same($state.snapshot(coreDraft), $state.snapshot(coreBaseline));
      if (!dirty && !editingUserAgent) {
        adoptCore(value);
      } else if (!same(value, $state.snapshot(coreBaseline))) {
        coreConflict = true;
      }
    });
    const disposeFeatures = registrations.map(entry => {
      const store = settings.store(entry.id);
      let wasRecovering = store.needsRecovery;
      return store.subscribe(() => {
        const nowRecovering = store.needsRecovery;
        featureRecovery[entry.id] = nowRecovering;
        if (wasRecovering && !nowRecovering && !settings.core.needsRecovery && manager) {
          void manager.reconcileFromLoadedSettings().catch(reconcileErr => {
            Logger.shared.error(`恢复功能配置后协调运行状态失败：${entry.id}`, reconcileErr);
          });
        }
        wasRecovering = nowRecovering;
      });
    });
    const disposeStatus = manager?.subscribeStatus(statuses => { runtimeStatuses = statuses; });
    return () => {
      disposeCore();
      disposeFeatures.forEach(dispose => dispose());
      disposeStatus?.();
      if (scrollTimeout) clearTimeout(scrollTimeout);
    };
  });

  function scrollToSection(id: string) {
    activeId = id;
    const target = sectionMap[id];
    if (!target || !scrollerEl) return;

    isProgrammaticScroll = true;
    if (scrollTimeout) clearTimeout(scrollTimeout);

    target.scrollIntoView({ behavior: "smooth", block: "start" });
    scrollTimeout = setTimeout(() => {
      isProgrammaticScroll = false;
    }, 500);
  }

  function onPanelScroll() {
    if (isProgrammaticScroll || !scrollerEl) return;
    const orderedIds = ["general", ...registrations.map(r => r.id)];
    const atBottom = scrollerEl.scrollTop + scrollerEl.clientHeight >= scrollerEl.scrollHeight - 4;
    if (atBottom) {
      for (let i = orderedIds.length - 1; i >= 0; i--) {
        if (sectionMap[orderedIds[i]]) {
          activeId = orderedIds[i];
          return;
        }
      }
    }

    const scrollerTop = scrollerEl.getBoundingClientRect().top;
    let bestId = "general";
    let minDistance = Infinity;
    for (const id of orderedIds) {
      const el = sectionMap[id];
      if (!el) continue;
      const relativeTop = el.getBoundingClientRect().top - scrollerTop;
      if (relativeTop <= 100) {
        const dist = Math.abs(relativeTop);
        if (dist < minDistance) {
          minDistance = dist;
          bestId = id;
        }
      }
    }
    activeId = bestId;
  }

  function toggleFeatureDraft(id: string, enabled: boolean): void {
    if (globalSaving || coreRecovery) return;
    const entry = registrations.find(item => item.id === id);
    if (!entry || !isFrontendSupported(entry.frontends)) return;
    const needsFeatureRecovery = featureRecovery[id] ?? settings.store(id).needsRecovery;
    if (needsFeatureRecovery) return;

    const nextCore = copy($state.snapshot(coreDraft));
    if (!Object.hasOwn(coreBaseline.featureStates, id) && enabled === entry.defaultEnabled) {
      delete nextCore.featureStates[id];
    } else {
      nextCore.featureStates[id] = { enabled };
    }
    coreDraft = nextCore;
    error = "";
    notice = "";
  }

  function discardCoreDraftAndReload(): void {
    if (globalSaving) return;
    adoptCore(settings.core.snapshot());
    error = "";
    notice = "";
  }

  function validateCore(): void {
    if (/[\r\n]/.test(coreDraft.general.userAgent)) {
      throw new Error(t("settings.invalidUserAgent"));
    }
  }

  function resetAllDrafts(): void {
    if (globalSaving || allReadOnly) return;
    error = "";
    notice = "";

    if (!coreRecovery) {
      const nextCore = copy($state.snapshot(coreDraft));
      nextCore.general.debugLog = false;
      nextCore.general.userAgent = DEFAULT_USER_AGENT;

      for (const entry of registrations) {
        if (!isFrontendSupported(entry.frontends)) continue;
        const needsFeatureRecovery = featureRecovery[entry.id] ?? settings.store(entry.id).needsRecovery;
        if (needsFeatureRecovery) {
          Logger.shared.debug(`重置草稿跳过只读恢复中的功能开关：${entry.id}`);
          continue;
        }
        if (!Object.hasOwn(coreBaseline.featureStates, entry.id)) {
          delete nextCore.featureStates[entry.id];
        } else {
          nextCore.featureStates[entry.id] = { enabled: entry.defaultEnabled };
        }
      }
      coreDraft = nextCore;
    } else {
      Logger.shared.debug("重置草稿跳过处于只读恢复状态的核心配置 (omnikit-core.json)");
    }

    for (const participant of Object.values(participants)) {
      if (participant.isReadOnly()) {
        Logger.shared.debug(`重置草稿跳过处于只读恢复状态的功能设置：${participant.id}`);
        continue;
      }
      participant.resetToDefaults();
    }
  }

  async function saveAll(): Promise<void> {
    if (globalSaving || hasAnyConflict) return;

    const dirtyParticipants = Object.values(participants).filter(
      participant => !participant.isReadOnly() && participant.isDirty(),
    );
    const coreNeedsSave = !coreRecovery && coreDirty;
    if (!coreNeedsSave && dirtyParticipants.length === 0) return;

    globalSaving = true;
    error = "";
    notice = "";

    const savedFeatureIds: string[] = [];
    try {
      for (const participant of dirtyParticipants) {
        participant.validate();
      }
      if (coreNeedsSave) {
        validateCore();
      }

      for (const participant of dirtyParticipants) {
        await participant.save();
        savedFeatureIds.push(participant.id);
      }

      if (coreNeedsSave) {
        const draftSnapshot = copy($state.snapshot(coreDraft));
        draftSnapshot.general.userAgent = draftSnapshot.general.userAgent.trim() || DEFAULT_USER_AGENT;
        const expected = copy($state.snapshot(coreBaseline));
        try {
          await settings.core.update(current => {
            if (!same(current, expected)) {
              throw new SettingsConflictError(t("settings.concurrentChange"));
            }
            current.general.debugLog = draftSnapshot.general.debugLog;
            current.general.userAgent = draftSnapshot.general.userAgent;
            current.featureStates = draftSnapshot.featureStates;
          });
          adoptCore(settings.core.snapshot());
        } catch (cause) {
          if (isSettingsConflictError(cause)) {
            coreConflict = true;
          }
          throw cause;
        }
      }

      if (manager) {
        await manager.reconcileFromLoadedSettings();
        for (const id of savedFeatureIds) {
          if (manager.isRunning(id)) {
            await manager.notifySettingsChanged(id);
          }
        }
      }

      notice = t("settings.saved");
    } catch (cause) {
      if (manager && savedFeatureIds.length > 0) {
        await manager.reconcileFromLoadedSettings().catch(reconcileError => {
          Logger.shared.debug("保存中断后协调运行状态失败", reconcileError);
        });
        for (const id of savedFeatureIds) {
          if (manager.isRunning(id)) {
            await manager.notifySettingsChanged(id).catch(notifyError => {
              Logger.shared.debug(`保存中断后通知功能配置更新失败：${id}`, notifyError);
            });
          }
        }
      }
      error = describeError(cause);
    } finally {
      globalSaving = false;
    }
  }

  async function recoverCore() {
    if (globalSaving) return;
    globalSaving = true;
    error = "";
    notice = "";
    try {
      try { await settings.core.reload(); } catch { /* still read-only; fall through */ }
      if (settings.core.needsRecovery) await settings.core.recoverWithBackup();
      adoptCore(settings.core.snapshot());
      coreRecovery = settings.core.needsRecovery;
      if (!coreRecovery && manager) {
        await manager.reconcileFromLoadedSettings();
      }
    } catch (cause) { error = describeError(cause); }
    finally { globalSaving = false; }
  }

  async function retry(id: string) {
    if (globalSaving || !manager) return;
    globalSaving = true;
    error = "";
    try {
      const ok = await manager.setEnabled(id, true, false);
      if (!ok) {
        throw manager.getStartupError(id) ?? new Error(t("toggleFailed"));
      }
    } catch (cause) { error = describeError(cause); }
    finally { globalSaving = false; }
  }
</script>

<div class="omnikit-settings-root">
  <SettingsSidebar
    {registrations}
    {activeId}
    {coreBaseline}
    {runtimeStatuses}
    hasManager={Boolean(manager)}
    {t}
    onSelect={scrollToSection} />

  <main class="omnikit-settings-scroller" bind:this={scrollerEl} onscroll={onPanelScroll}>
    <div class="scroller-inner">
      {#if error}
        <div class="global-error-banner" role="alert">
          <svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor"><path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm1 15h-2v-2h2v2zm0-4h-2V7h2v6z"/></svg>
          <span>{error}</span>
        </div>
      {/if}

      <GeneralSettingsCard
        sectionRef={el => setSectionRef("general", el)}
        generalDraft={coreDraft.general}
        {coreRecovery}
        coreError={settings.core.error}
        {coreConflict}
        {globalSaving}
        {t}
        onUpdateDebugLog={checked => { coreDraft.general.debugLog = checked; error = ""; notice = ""; }}
        onUpdateUserAgent={val => { coreDraft.general.userAgent = val; error = ""; notice = ""; }}
        onRecover={recoverCore}
        onDiscardReload={discardCoreDraftAndReload} />

      {#each registrations as entry (entry.id)}
        <FeatureSettingsCard
          sectionRef={el => setSectionRef(entry.id, el)}
          {entry}
          store={settings.store(entry.id)}
          committedEnabled={coreBaseline.featureStates[entry.id]?.enabled ?? entry.defaultEnabled}
          draftEnabled={coreDraft.featureStates[entry.id]?.enabled ?? entry.defaultEnabled}
          needsFeatureRecovery={featureRecovery[entry.id] ?? settings.store(entry.id).needsRecovery}
          {coreRecovery}
          runtime={runtimeStatuses.find(status => status.id === entry.id)}
          hasManager={Boolean(manager)}
          {globalSaving}
          {registerDraft}
          {t}
          onToggle={enabled => toggleFeatureDraft(entry.id, enabled)}
          onRetry={() => retry(entry.id)} />
      {/each}

      <div class="scroll-bottom-spacer"></div>
    </div>

    <SettingsSaveBar
      {anyDirty}
      {globalSaving}
      {allReadOnly}
      {hasAnyConflict}
      {statusText}
      {t}
      onReset={resetAllDrafts}
      onSave={saveAll} />
  </main>
</div>

<style lang="scss">
  .omnikit-settings-root {
    display: flex;
    width: 100%;
    height: 100%;
    min-height: 0;
    background: var(--b3-theme-background);
    color: var(--b3-theme-on-background);
    user-select: none;
    overflow: hidden;
  }

  .omnikit-settings-scroller {
    flex: 1;
    overflow-y: auto;
    overflow-x: hidden;
    scroll-behavior: smooth;
    padding: 1.25rem 1.75rem 0;
    box-sizing: border-box;

    &::-webkit-scrollbar {
      width: 6px;
    }
    &::-webkit-scrollbar-thumb {
      background: var(--b3-theme-on-surface-light);
      border-radius: 3px;
      opacity: 0.3;
    }
  }

  .scroller-inner {
    max-width: 52rem;
    margin: 0 auto;
    display: flex;
    flex-direction: column;
    gap: 1.5rem;
  }

  .global-error-banner {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    background: color-mix(in srgb, var(--b3-theme-error) 12%, transparent);
    color: var(--b3-theme-error);
    padding: 0.75rem 1rem;
    border-radius: 8px;
    font-size: 0.85rem;
  }

  .scroll-bottom-spacer {
    height: 15rem;
  }

  @media (max-width: 680px) {
    .omnikit-settings-root {
      flex-direction: column;
    }

    .omnikit-settings-scroller {
      padding: 1rem 1rem 0;
    }
  }
</style>
