<script lang="ts">
  import type { FeaturePhase } from "../../core/framework/BaseFeature.ts";
  import type { FeatureRegistration } from "../../core/framework/FeatureRegistration.ts";
  import type { JsonStore } from "../../core/store/JsonStore.ts";
  import type { FeatureStatus } from "../../core/framework/FeatureManager.ts";
  import { isFrontendSupported, type SiyuanFrontend } from "../../core/host/Platform.ts";
  import type { RegisterDraftParticipant } from "./DraftParticipant.ts";

  interface Props {
    sectionRef: (el: HTMLElement | undefined) => void;
    entry: FeatureRegistration<any>;
    store: JsonStore<any>;
    committedEnabled: boolean;
    draftEnabled: boolean;
    needsFeatureRecovery: boolean;
    coreRecovery: boolean;
    runtime?: FeatureStatus;
    hasManager: boolean;
    globalSaving: boolean;
    registerDraft: RegisterDraftParticipant;
    t: (key: string, values?: Record<string, string | number>) => string;
    onToggle: (enabled: boolean) => void;
    onRetry: () => void;
  }

  let {
    sectionRef,
    entry,
    store,
    committedEnabled,
    draftEnabled,
    needsFeatureRecovery,
    coreRecovery,
    runtime,
    hasManager,
    globalSaving,
    registerDraft,
    t,
    onToggle,
    onRetry,
  }: Props = $props();

  let View = $derived(entry.settingsView);
  let isSupported = $derived(isFrontendSupported(entry.frontends));
  let isRunning = $derived(isSupported && runtime?.status === "enabled");
  let isConfigured = $derived(!hasManager && isSupported && committedEnabled);
  let preferenceUnreadable = $derived(
    (coreRecovery || needsFeatureRecovery) && committedEnabled && hasManager && runtime?.status !== "enabled",
  );
  let derivedPhase = $derived<FeaturePhase | "configured">(
    !isSupported
      ? "unsupported"
      : (preferenceUnreadable ? "error" : (runtime?.status ?? (isConfigured ? "configured" : "disabled"))),
  );

  function bindSection(node: HTMLElement) {
    sectionRef(node);
    return {
      destroy() {
        sectionRef(undefined);
      },
    };
  }

  function formatPlatformName(frontend: SiyuanFrontend): string {
    switch (frontend) {
      case "desktop": return t("platform.desktop");
      case "desktop-window": return t("platform.desktopWindow");
      case "mobile": return t("platform.mobile");
      case "browser-desktop": return t("platform.browserDesktop");
      case "browser-mobile": return t("platform.browserMobile");
      case "all": return t("platform.all");
      default: return String(frontend);
    }
  }

  function formatUnsupportedHint(frontends?: readonly SiyuanFrontend[]): string {
    const list: readonly SiyuanFrontend[] = frontends && frontends.length > 0 ? frontends : ["all"];
    const platforms = list.map(formatPlatformName).join(" / ");
    return t("feature.unsupportedFrontend", { platforms });
  }
</script>

<section
  id="section-{entry.id}"
  class="feature-card"
  class:disabled-card={!draftEnabled || !isSupported}
  use:bindSection>
  <header class="card-header">
    <div class="card-title-group">
      <div class="title-with-badge">
        <h2 class="card-title">{t(entry.titleKey)}</h2>
        {#if !isSupported}
          <span class="pill-badge pill-unsupported">
            {t("runtime.unsupported")}
          </span>
        {:else}
          <span
            class="pill-badge"
            class:pill-active={isRunning}
            class:pill-configured={isConfigured}
            class:pill-error={derivedPhase === "error"}
            class:pill-muted={!committedEnabled && derivedPhase !== "error"}>
            {preferenceUnreadable ? t("runtime.preferenceUnreadable") : t(`runtime.${derivedPhase}`)}
          </span>
        {/if}
      </div>
      <p class="card-desc">{t(entry.descriptionKey)}</p>
      {#if !isSupported}
        <p class="card-unsupported-hint">{formatUnsupportedHint(entry.frontends)}</p>
      {/if}
    </div>

    <label class="toggle-wrapper" title={!isSupported ? t("runtime.unsupported") : t("feature.enabled")}>
      <input
        class="b3-switch"
        type="checkbox"
        checked={draftEnabled}
        disabled={globalSaving || coreRecovery || needsFeatureRecovery || !isSupported}
        onchange={e => onToggle(e.currentTarget.checked)} />
    </label>
  </header>

  <div class="card-body">
    {#if hasManager && runtime?.status === "error" && runtime.error}
      <div class="runtime-error-box" role="alert">
        <p class="omnikit-error">{runtime.error}</p>
        <button
          class="b3-button b3-button--cancel"
          disabled={globalSaving || coreRecovery || needsFeatureRecovery}
          onclick={onRetry}>
          {t("runtime.retry")}
        </button>
      </div>
    {/if}

    <div class="view-wrapper" class:view-dimmed={!draftEnabled || !isSupported}>
      <View {store} runtimePhase={derivedPhase} {t} {registerDraft} {globalSaving} />
    </div>
  </div>
</section>

<style lang="scss">
  .feature-card {
    background: var(--b3-theme-surface);
    border: 1px solid var(--b3-border-color);
    border-radius: 10px;
    padding: 1.25rem 1.5rem;
    box-shadow: 0 1px 4px color-mix(in srgb, var(--b3-theme-on-background) 6%, transparent);
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
      background: color-mix(in srgb, var(--b3-theme-success) 15%, transparent);
      color: var(--b3-theme-success);
    }
    &.pill-configured {
      background: var(--b3-theme-primary-lightest, color-mix(in srgb, var(--b3-theme-primary) 12%, transparent));
      color: var(--b3-theme-primary);
    }
    &.pill-error {
      background: color-mix(in srgb, var(--b3-theme-error) 15%, transparent);
      color: var(--b3-theme-error);
    }
    &.pill-muted {
      background: var(--b3-theme-surface-lighter);
      color: var(--b3-theme-on-surface-light);
    }
    &.pill-unsupported {
      background: var(--b3-theme-surface-lighter);
      color: var(--b3-theme-on-surface-light);
      border: 1px dashed var(--b3-theme-on-surface-light);
    }
  }

  .card-unsupported-hint {
    margin: 0.35rem 0 0;
    font-size: 0.8rem;
    color: var(--b3-theme-on-surface-light);
    line-height: 1.4;
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

  .runtime-error-box {
    margin-bottom: 1rem;
    padding: 0.75rem;
    border-radius: 6px;
    background: color-mix(in srgb, var(--b3-theme-error) 12%, transparent);
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
  }

  .omnikit-error {
    color: var(--b3-theme-error);
    margin: 0;
    font-size: 0.85rem;
  }
</style>
