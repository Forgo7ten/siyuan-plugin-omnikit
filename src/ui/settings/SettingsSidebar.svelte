<script lang="ts">
  import type { FeatureRegistration } from "../../core/framework/FeatureRegistration.ts";
  import type { CoreSettings } from "../../core/store/SettingsManager.ts";
  import type { FeatureStatus } from "../../core/framework/FeatureManager.ts";
  import { isFrontendSupported } from "../../core/host/Platform.ts";

  interface Props {
    registrations: readonly FeatureRegistration<any>[];
    activeId: string;
    coreBaseline: CoreSettings;
    runtimeStatuses: readonly FeatureStatus[];
    hasManager: boolean;
    t: (key: string, values?: Record<string, string | number>) => string;
    onSelect: (id: string) => void;
  }

  let {
    registrations,
    activeId,
    coreBaseline,
    runtimeStatuses,
    hasManager,
    t,
    onSelect,
  }: Props = $props();
</script>

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
    <button
      class="nav-item"
      class:active={activeId === "general"}
      onclick={() => onSelect("general")}>
      <div class="nav-item-content">
        <svg class="item-icon" viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2">
          <circle cx="12" cy="12" r="3"/>
          <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/>
        </svg>
        <span class="item-label">{t("general.title")}</span>
      </div>
    </button>

    <div class="nav-divider"></div>
    <div class="nav-section-title">{t("nav.features")}</div>

    {#each registrations as entry (entry.id)}
      {@const committedEnabled = coreBaseline.featureStates[entry.id]?.enabled ?? entry.defaultEnabled}
      {@const runtime = runtimeStatuses.find(status => status.id === entry.id)}
      {@const isSupported = isFrontendSupported(entry.frontends)}
      {@const isRunning = isSupported && runtime?.status === "enabled"}
      {@const isConfigured = !hasManager && isSupported && committedEnabled}
      {@const isError = isSupported && runtime?.status === "error"}

      <button
        class="nav-item"
        class:active={activeId === entry.id}
        class:unsupported={!isSupported}
        onclick={() => onSelect(entry.id)}>
        <div class="nav-item-content">
          <span
            class="status-indicator"
            class:running={isRunning}
            class:configured={isConfigured}
            class:error={isError}
            class:unsupported={!isSupported}
            class:disabled={!committedEnabled && isSupported}></span>
          <span class="item-label">{t(entry.titleKey)}</span>
        </div>
        {#if !isSupported}
          <span class="item-badge unsupported">N/A</span>
        {:else if committedEnabled}
          <span class="item-badge" class:error={isError}>
            {isError ? "!" : "ON"}
          </span>
        {/if}
      </button>
    {/each}
  </nav>
</aside>

<style lang="scss">
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
      background: var(--b3-theme-primary-lightest, color-mix(in srgb, var(--b3-theme-primary) 12%, transparent));
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
      background: var(--b3-theme-success);
      box-shadow: 0 0 6px var(--b3-theme-success);
    }

    &.configured {
      background: var(--b3-theme-primary);
      opacity: 0.85;
    }

    &.error {
      background: var(--b3-theme-error);
      box-shadow: 0 0 6px var(--b3-theme-error);
    }

    &.disabled {
      opacity: 0.4;
    }

    &.unsupported {
      opacity: 0.25;
      background: var(--b3-theme-on-surface-light);
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
      color: var(--b3-theme-on-error);
    }

    &.unsupported {
      background: var(--b3-theme-surface-lighter);
      color: var(--b3-theme-on-surface-light);
      opacity: 0.7;
    }
  }

  @media (max-width: 680px) {
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
  }
</style>
