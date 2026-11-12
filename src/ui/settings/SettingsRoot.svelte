<script lang="ts">
  import { onMount, untrack } from "svelte";
  import type { FeatureRegistration } from "../../core/FeatureRegistration.ts";
  import type { SettingsManager, CoreSettings } from "../../core/SettingsManager.ts";
  import type { FeatureManager } from "../../core/FeatureManager.ts";
  import type { FeatureStatus } from "../../core/FeatureManager.ts";

  interface Props {
    registrations: readonly FeatureRegistration<any>[];
    settings: SettingsManager;
    manager?: FeatureManager;
    t: (key: string) => string;
  }

  let { registrations, settings, manager, t }: Props = $props();
  let core = $state<CoreSettings>(untrack(() => settings.core.snapshot()));
  let coreRecovery = $state(untrack(() => settings.core.needsRecovery));
  let featureRecovery = $state<Record<string, boolean>>({});
  let activeId = $state("general");
  let busy = $state(false);
  let error = $state("");
  let runtimeStatuses = $state<FeatureStatus[]>(untrack(() => manager?.statuses() ?? []));

  let scrollerEl: HTMLElement | undefined;
  const sectionMap: Record<string, HTMLElement> = {};
  let isProgrammaticScroll = false;
  let scrollTimeout: ReturnType<typeof setTimeout> | undefined;

  onMount(() => {
    const disposeCore = settings.core.subscribe(value => {
      core = value as CoreSettings;
      coreRecovery = settings.core.needsRecovery;
    });
    const disposeFeatures = registrations.map(entry => {
      const store = settings.store(entry.id);
      return store.subscribe(() => { featureRecovery[entry.id] = store.needsRecovery; });
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
    const scrollerTop = scrollerEl.getBoundingClientRect().top;

    let bestId = "general";
    let minDistance = Infinity;

    for (const [id, el] of Object.entries(sectionMap)) {
      if (!el) continue;
      const rect = el.getBoundingClientRect();
      const relativeTop = rect.top - scrollerTop;

      // When the top of the card is near or slightly above the container top
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

  async function changeDebugLog(enabled: boolean) {
    if (busy) return;
    busy = true;
    error = "";
    try {
      await settings.updateGeneral({ debugLog: enabled });
      core = settings.core.snapshot();
    } catch (cause) { error = String(cause); }
    finally { busy = false; }
  }

  async function recoverCore() {
    if (busy) return;
    busy = true;
    error = "";
    try {
      await settings.core.recoverWithBackup();
      core = settings.core.snapshot();
    } catch (cause) { error = String(cause); }
    finally { busy = false; }
  }

  async function toggle(id: string, enabled: boolean) {
    if (busy) return;
    busy = true;
    error = "";
    try {
      const ok = manager
        ? await manager.setEnabled(id, enabled)
        : (await settings.setFeatureEnabled(id, enabled), true);
      if (!ok) throw new Error(t("toggleFailed"));
      core = settings.core.snapshot();
    } catch (cause) { error = String(cause); }
    finally { busy = false; }
  }

  async function retry(id: string) {
    if (busy || !manager) return;
    busy = true;
    error = "";
    try {
      const ok = await manager.setEnabled(id, true);
      if (!ok) throw new Error(t("toggleFailed"));
    } catch (cause) { error = String(cause); }
    finally { busy = false; }
  }
</script>

<div class="omnikit-settings-root">
  <!-- Left: iPad-Style Sidebar Navigation -->
  <aside class="omnikit-sidebar" aria-label="OmniKit Settings">
    <div class="sidebar-header">
      <div class="sidebar-logo">
        <svg class="icon-omnikit" viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2">
          <circle cx="12" cy="12" r="9"/>
          <path d="M12 3v18M3 12h18"/>
        </svg>
        <span class="logo-title">OmniKit</span>
      </div>
    </div>

    <nav class="sidebar-nav">
      <!-- General Tab -->
      <button
        class="nav-item"
        class:active={activeId === "general"}
        onclick={() => scrollToSection("general")}>
        <div class="nav-item-content">
          <svg class="item-icon" viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2">
            <circle cx="12" cy="12" r="3"/>
            <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/>
          </svg>
          <span class="item-label">{t("general.title")}</span>
        </div>
      </button>

      <div class="nav-divider"></div>
      <div class="nav-section-title">{t("status") ? "功能模块" : "Features"}</div>

      <!-- Features Tabs -->
      {#each registrations as entry (entry.id)}
        {@const enabled = core.featureStates[entry.id]?.enabled ?? entry.defaultEnabled}
        {@const runtime = runtimeStatuses.find(status => status.id === entry.id)}
        {@const isRunning = enabled && runtime?.status === "enabled"}
        {@const isError = runtime?.status === "error"}

        <button
          class="nav-item"
          class:active={activeId === entry.id}
          onclick={() => scrollToSection(entry.id)}>
          <div class="nav-item-content">
            <span class="status-indicator" class:running={isRunning} class:error={isError} class:disabled={!enabled}></span>
            <span class="item-label">{t(entry.titleKey)}</span>
          </div>
          {#if enabled}
            <span class="item-badge" class:error={isError}>
              {isError ? "!" : "ON"}
            </span>
          {/if}
        </button>
      {/each}
    </nav>
  </aside>

  <!-- Right: Single-Page Continuous Scroll Area -->
  <main class="omnikit-settings-scroller" bind:this={scrollerEl} onscroll={onPanelScroll}>
    <div class="scroller-inner">
      {#if error}
        <div class="global-error-banner" role="alert">
          <svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor"><path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm1 15h-2v-2h2v2zm0-4h-2V7h2v6z"/></svg>
          <span>{error}</span>
        </div>
      {/if}

      <!-- Section: General Settings -->
      <section
        id="section-general"
        class="feature-card"
        bind:this={sectionMap["general"]}>
        <header class="card-header">
          <div class="card-title-group">
            <h2 class="card-title">{t("general.title")}</h2>
            <p class="card-desc">{t("general.debugLogNote") || "管理插件全局偏好与运行行为"}</p>
          </div>
        </header>

        <div class="card-body">
          {#if coreRecovery}
            <div class="recovery-box">
              <p class="omnikit-error" role="alert">{settings.core.error}</p>
              <button class="b3-button b3-button--cancel" disabled={busy} onclick={recoverCore}>
                {t("recovery.settingsButton")}
              </button>
            </div>
          {/if}

          <div class="setting-row">
            <div class="setting-info">
              <span class="setting-title">{t("general.debugLog")}</span>
              <span class="setting-hint">仅输出到浏览器开发者工具控制台，不写入工作空间文件</span>
            </div>
            <input
              class="b3-switch"
              type="checkbox"
              checked={core.general.debugLog}
              disabled={busy || coreRecovery}
              onchange={e => changeDebugLog(e.currentTarget.checked)} />
          </div>
        </div>
      </section>

      <!-- Sections: Feature Cards -->
      {#each registrations as entry (entry.id)}
        {@const View = entry.settingsView}
        {@const needsFeatureRecovery = featureRecovery[entry.id] ?? settings.store(entry.id).needsRecovery}
        {@const enabled = core.featureStates[entry.id]?.enabled ?? entry.defaultEnabled}
        {@const runtime = runtimeStatuses.find(status => status.id === entry.id)}
        {@const isRunning = enabled && runtime?.status === "enabled"}

        <section
          id="section-{entry.id}"
          class="feature-card"
          class:disabled-card={!enabled}
          bind:this={sectionMap[entry.id]}>
          <header class="card-header">
            <div class="card-title-group">
              <div class="title-with-badge">
                <h2 class="card-title">{t(entry.titleKey)}</h2>
                <span class="pill-badge" class:pill-active={isRunning} class:pill-error={runtime?.status === "error"} class:pill-muted={!enabled}>
                  {t(`runtime.${runtime?.status ?? "disabled"}`)}
                </span>
              </div>
              <p class="card-desc">{t(entry.descriptionKey)}</p>
            </div>

            <label class="toggle-wrapper" title={t("feature.enabled")}>
              <input
                class="b3-switch"
                type="checkbox"
                checked={enabled}
                disabled={busy || coreRecovery || needsFeatureRecovery}
                onchange={e => toggle(entry.id, e.currentTarget.checked)} />
            </label>
          </header>

          <div class="card-body">
            {#if manager}
              {#if runtime?.status === "error" && runtime.error}
                <div class="runtime-error-box" role="alert">
                  <p class="omnikit-error">{runtime.error}</p>
                  <button class="b3-button b3-button--cancel" disabled={busy || coreRecovery || needsFeatureRecovery} onclick={() => retry(entry.id)}>
                    {t("runtime.retry")}
                  </button>
                </div>
              {/if}
            {/if}

            <div class="view-wrapper" class:view-dimmed={!enabled}>
              <View store={settings.store(entry.id)} runtimePhase={runtime?.status ?? "disabled"} {t} />
            </div>
          </div>
        </section>
      {/each}

      <div class="scroll-bottom-spacer"></div>
    </div>
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

  /* --- Left Sidebar (iPadOS Style) --- */
  .omnikit-sidebar {
    width: 13.5rem;
    flex: 0 0 13.5rem;
    display: flex;
    flex-direction: column;
    background: var(--b3-theme-surface);
    border-right: 1px solid var(--b3-border-color);
    padding: 0.75rem 0.5rem;
    box-sizing: border-box;
  }

  .sidebar-header {
    padding: 0.5rem 0.75rem 0.75rem;
  }

  .sidebar-logo {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    font-weight: 600;
    font-size: 1.05rem;
    color: var(--b3-theme-primary);

    .icon-omnikit {
      stroke: var(--b3-theme-primary);
    }
  }

  .sidebar-nav {
    flex: 1;
    overflow-y: auto;
    display: flex;
    flex-direction: column;
    gap: 0.25rem;
  }

  .nav-section-title {
    font-size: 0.75rem;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.05em;
    color: var(--b3-theme-on-surface-light);
    padding: 0.5rem 0.75rem 0.25rem;
  }

  .nav-divider {
    height: 1px;
    background: var(--b3-border-color);
    margin: 0.4rem 0.5rem;
    opacity: 0.6;
  }

  .nav-item {
    display: flex;
    align-items: center;
    justify-content: space-between;
    width: 100%;
    padding: 0.5rem 0.75rem;
    border-radius: 8px;
    background: transparent;
    border: none;
    color: var(--b3-theme-on-surface);
    font-size: 0.88rem;
    cursor: pointer;
    text-align: left;
    transition: all 0.18s cubic-bezier(0.4, 0, 0.2, 1);
    box-sizing: border-box;

    &:hover {
      background: var(--b3-theme-surface-lighter);
    }

    &.active {
      background: var(--b3-theme-primary-light);
      color: var(--b3-theme-primary);
      font-weight: 600;

      .item-icon {
        stroke: var(--b3-theme-primary);
      }
    }
  }

  .nav-item-content {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    min-width: 0;
  }

  .item-icon {
    flex-shrink: 0;
    opacity: 0.8;
  }

  .item-label {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .status-indicator {
    width: 7px;
    height: 7px;
    border-radius: 50%;
    background: var(--b3-theme-on-surface-light);
    flex-shrink: 0;
    transition: background-color 0.2s ease;

    &.running {
      background: var(--b3-theme-success, #2ba471);
      box-shadow: 0 0 6px var(--b3-theme-success, #2ba471);
    }

    &.error {
      background: var(--b3-theme-error);
      box-shadow: 0 0 6px var(--b3-theme-error);
    }

    &.disabled {
      opacity: 0.4;
    }
  }

  .item-badge {
    font-size: 0.68rem;
    padding: 1px 5px;
    border-radius: 4px;
    background: var(--b3-theme-surface-lighter);
    color: var(--b3-theme-on-surface-light);
    font-weight: 600;

    &.error {
      background: var(--b3-theme-error);
      color: #fff;
    }
  }

  /* --- Right Scroller (Single Page Continuous Flow) --- */
  .omnikit-settings-scroller {
    flex: 1;
    overflow-y: auto;
    overflow-x: hidden;
    scroll-behavior: smooth;
    padding: 1.25rem 1.75rem;
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
    background: var(--b3-theme-error-light, rgba(224, 62, 62, 0.1));
    color: var(--b3-theme-error);
    padding: 0.75rem 1rem;
    border-radius: 8px;
    font-size: 0.85rem;
  }

  /* --- Feature Cards (Card Archipelago) --- */
  .feature-card {
    background: var(--b3-theme-surface);
    border: 1px solid var(--b3-border-color);
    border-radius: 10px;
    padding: 1.25rem 1.5rem;
    box-shadow: 0 1px 4px rgba(0, 0, 0, 0.03);
    transition: border-color 0.2s ease, box-shadow 0.2s ease;
    scroll-margin-top: 1.25rem;

    &.disabled-card {
      border-style: dashed;
      background: var(--b3-theme-surface);
      opacity: 0.95;
    }
  }

  .card-header {
    display: flex;
    align-items: flex-start;
    justify-content: space-between;
    gap: 1.25rem;
    padding-bottom: 0.75rem;
    border-bottom: 1px solid var(--b3-border-color);
    margin-bottom: 1rem;
  }

  .card-title-group {
    flex: 1;
    min-width: 0;
  }

  .title-with-badge {
    display: flex;
    align-items: center;
    gap: 0.6rem;
    flex-wrap: wrap;
  }

  .card-title {
    margin: 0;
    font-size: 1.15rem;
    font-weight: 600;
    color: var(--b3-theme-on-background);
  }

  .card-desc {
    margin: 0.3rem 0 0;
    font-size: 0.82rem;
    color: var(--b3-theme-on-surface-light);
    line-height: 1.4;
  }

  .pill-badge {
    font-size: 0.72rem;
    padding: 2px 7px;
    border-radius: 12px;
    font-weight: 500;
    line-height: 1.2;

    &.pill-active {
      background: var(--b3-theme-success-light, rgba(43, 164, 113, 0.15));
      color: var(--b3-theme-success, #2ba471);
    }
    &.pill-error {
      background: var(--b3-theme-error-light, rgba(224, 62, 62, 0.15));
      color: var(--b3-theme-error);
    }
    &.pill-muted {
      background: var(--b3-theme-surface-lighter);
      color: var(--b3-theme-on-surface-light);
    }
  }

  .toggle-wrapper {
    flex-shrink: 0;
    padding-top: 0.2rem;
  }

  .card-body {
    user-select: text;
  }

  .view-wrapper {
    transition: opacity 0.2s ease;
    &.view-dimmed {
      opacity: 0.75;
    }
  }

  /* Setting row for general */
  .setting-row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 1rem;
    padding: 0.5rem 0;
  }

  .setting-info {
    display: flex;
    flex-direction: column;
    gap: 0.2rem;
  }

  .setting-title {
    font-size: 0.92rem;
    font-weight: 500;
  }

  .setting-hint {
    font-size: 0.8rem;
    color: var(--b3-theme-on-surface-light);
  }

  .recovery-box, .runtime-error-box {
    margin-bottom: 1rem;
    padding: 0.75rem;
    border-radius: 6px;
    background: var(--b3-theme-error-light, rgba(224, 62, 62, 0.1));
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
  }

  .omnikit-error {
    color: var(--b3-theme-error);
    margin: 0;
    font-size: 0.85rem;
  }

  .scroll-bottom-spacer {
    height: 15rem; /* Ensures even the last card can cleanly scroll to the top of the viewport */
  }

  /* --- Responsive for narrow screens --- */
  @media (max-width: 680px) {
    .omnikit-settings-root {
      flex-direction: column;
    }

    .omnikit-sidebar {
      width: 100%;
      flex: 0 0 auto;
      border-right: none;
      border-bottom: 1px solid var(--b3-border-color);
      padding: 0.4rem 0.5rem;
    }

    .sidebar-header, .nav-section-title, .nav-divider {
      display: none;
    }

    .sidebar-nav {
      flex-direction: row;
      overflow-x: auto;
      gap: 0.4rem;
    }

    .nav-item {
      flex: 0 0 auto;
      width: auto;
      padding: 0.4rem 0.75rem;
    }

    .omnikit-settings-scroller {
      padding: 1rem;
    }
  }
</style>
