<script lang="ts">
  import type { ToolbarActions, ToolbarViewState } from "../model/toolbarState.ts";
  import type { DiffFilter } from "../model/types.ts";

  interface Props {
    getState: () => ToolbarViewState;
    actions: ToolbarActions;
    t: (key: string, values?: Record<string, string | number>) => string;
  }

  let { getState, actions, t }: Props = $props();
  let view = $derived(getState());

  let customPos = $state<{ x: number; y: number } | null>(null);
  let dragging = $state(false);
  let dragStart = { pointerX: 0, pointerY: 0, startX: 0, startY: 0 };
  let toolbarEl: HTMLDivElement | undefined = $state();

  function formatDocTooltip(sideLabel: string, doc: ToolbarViewState["leftDoc"]): string {
    const pathInfo = doc.hPath
      ? (doc.notebookName ? `${doc.notebookName}${doc.hPath}` : doc.hPath)
      : (doc.notebookName ?? doc.notebook);
    return pathInfo ? `${sideLabel}: ${doc.title}\n${pathInfo}` : `${sideLabel}: ${doc.title}`;
  }

  function clampToViewport(x: number, y: number, rect: DOMRect): { x: number; y: number } {
    const maxX = Math.max(8, window.innerWidth - rect.width - 8);
    const maxY = Math.max(8, window.innerHeight - rect.height - 8);
    return {
      x: Math.min(maxX, Math.max(8, x)),
      y: Math.min(maxY, Math.max(8, y)),
    };
  }

  function onGripPointerDown(event: PointerEvent): void {
    if (event.button !== 0 || !toolbarEl) return;
    const rect = toolbarEl.getBoundingClientRect();
    const startX = customPos ? customPos.x : rect.left;
    const startY = customPos ? customPos.y : rect.top;
    customPos = clampToViewport(startX, startY, rect);
    dragStart = { pointerX: event.clientX, pointerY: event.clientY, startX: customPos.x, startY: customPos.y };
    dragging = true;
    (event.currentTarget as HTMLElement).setPointerCapture(event.pointerId);
    event.preventDefault();
  }

  function onGripPointerMove(event: PointerEvent): void {
    if (!dragging || !toolbarEl) return;
    customPos = clampToViewport(
      dragStart.startX + (event.clientX - dragStart.pointerX),
      dragStart.startY + (event.clientY - dragStart.pointerY),
      toolbarEl.getBoundingClientRect(),
    );
  }

  function onWindowResize(): void {
    if (!customPos || !toolbarEl) return;
    const clamped = clampToViewport(customPos.x, customPos.y, toolbarEl.getBoundingClientRect());
    if (clamped.x !== customPos.x || clamped.y !== customPos.y) {
      customPos = clamped;
    }
  }

  function onGripPointerUp(event: PointerEvent): void {
    if (!dragging) return;
    dragging = false;
    const el = event.currentTarget as HTMLElement;
    if (el.hasPointerCapture(event.pointerId)) {
      el.releasePointerCapture(event.pointerId);
    }
  }

  const filterChips = $derived.by(() => {
    const c = view.counts;
    const items: Array<{ id: DiffFilter; label: string; count: number; dotClass: string }> = [
      { id: "all", label: t("diff.filter.all"), count: c.all, dotClass: "dot--all" },
      { id: "removed", label: t("diff.filter.removed"), count: c.removed, dotClass: "dot--removed" },
      { id: "added", label: t("diff.filter.added"), count: c.added, dotClass: "dot--added" },
      { id: "modified", label: t("diff.filter.modified"), count: c.modified, dotClass: "dot--modified" },
    ];
    if (c.unresolved > 0 || view.filter === "unresolved") {
      items.push({
        id: "unresolved",
        label: t("diff.filter.unresolved"),
        count: c.unresolved,
        dotClass: "dot--unresolved",
      });
    }
    return items;
  });
</script>

<svelte:window onresize={onWindowResize} />

<div
  bind:this={toolbarEl}
  class="omnikit-diff-toolbar"
  role="toolbar"
  aria-label={t("feature.documentDiff.title")}
  style={customPos
    ? `left: ${customPos.x}px; top: ${customPos.y}px; transform: none;`
    : undefined}
>
  <div
    class="omnikit-diff-toolbar__grip"
    title={t("diff.toolbar.dragHint")}
    role="presentation"
    onpointerdown={onGripPointerDown}
    onpointermove={onGripPointerMove}
    onpointerup={onGripPointerUp}
    onpointercancel={onGripPointerUp}
  >
    <span class="omnikit-diff-toolbar__dots">⋮⋮</span>
  </div>

  <div class="omnikit-diff-toolbar__identities">
    <span
      class="omnikit-diff-toolbar__doc"
      title={formatDocTooltip(t("diff.toolbar.leftSide"), view.leftDoc)}
    >
      <span class="omnikit-diff-toolbar__dot dot--removed" aria-hidden="true"></span>
      <span class="omnikit-diff-toolbar__doc-title">{view.leftDoc.title}</span>
    </span>
    <span class="omnikit-diff-toolbar__arrow" aria-hidden="true">⇄</span>
    <span
      class="omnikit-diff-toolbar__doc"
      title={formatDocTooltip(t("diff.toolbar.rightSide"), view.rightDoc)}
    >
      <span class="omnikit-diff-toolbar__dot dot--added" aria-hidden="true"></span>
      <span class="omnikit-diff-toolbar__doc-title">{view.rightDoc.title}</span>
    </span>
  </div>

  <span class="omnikit-diff-toolbar__sep" aria-hidden="true"></span>

  <span
    class="omnikit-diff-toolbar__status"
    class:status--warning={view.statusKind === "unconfirmed" || view.statusKind === "unresolved"}
    class:status--error={view.statusKind === "failed"}
    role="status"
    aria-live="polite"
  >
    {view.statusText}
  </span>

  {#if view.statusKind === "diff" || view.statusKind === "unresolved" || view.statusKind === "equal"}
    <div class="omnikit-diff-toolbar__chips" role="group" aria-label={t("diff.toolbar.filtersAria")}>
      {#each filterChips as chip (chip.id)}
        <button
          type="button"
          class="b3-chip b3-chip--middle b3-chip--pointer omnikit-diff-chip"
          class:b3-chip--current={view.filter === chip.id}
          aria-pressed={view.filter === chip.id}
          onclick={() => actions.onToggleFilter(chip.id)}
        >
          <span class="omnikit-diff-toolbar__dot {chip.dotClass}" aria-hidden="true"></span>
          <span>{chip.label} {chip.count}</span>
        </button>
      {/each}
    </div>
  {/if}

  <span class="omnikit-diff-toolbar__sep" aria-hidden="true"></span>

  <div class="omnikit-diff-toolbar__actions">
    <button
      type="button"
      class="block__icon block__icon--show b3-tooltips b3-tooltips__s"
      aria-label={t("diff.toolbar.prev")}
      disabled={!view.canNavigate}
      onclick={actions.onPrev}
    >
      <svg><use xlink:href="#iconUp"></use></svg>
    </button>
    <span class="omnikit-diff-toolbar__counter">
      {view.cursorIndex}/{view.filteredTotal}
    </span>
    <button
      type="button"
      class="block__icon block__icon--show b3-tooltips b3-tooltips__s"
      aria-label={t("diff.toolbar.next")}
      disabled={!view.canNavigate}
      onclick={actions.onNext}
    >
      <svg><use xlink:href="#iconDown"></use></svg>
    </button>

    <button
      type="button"
      class="b3-button b3-button--outline omnikit-diff-toolbar__toggle"
      class:is-active={view.syncEnabled}
      aria-pressed={view.syncEnabled}
      title={t("diff.toolbar.syncScrollHelp")}
      onclick={actions.onToggleSync}
    >
      {view.syncEnabled ? t("diff.toolbar.syncOn") : t("diff.toolbar.syncOff")}
    </button>

    <button
      type="button"
      class="block__icon block__icon--show b3-tooltips b3-tooltips__s"
      aria-label={view.canSwap ? t("diff.toolbar.swap") : t("diff.notice.swapManualHint")}
      disabled={!view.canSwap}
      onclick={actions.onSwap}
    >
      <svg><use xlink:href="#iconScrollHoriz"></use></svg>
    </button>

    <button
      type="button"
      class="block__icon block__icon--show b3-tooltips b3-tooltips__s"
      aria-label={t("diff.toolbar.refresh")}
      onclick={actions.onRefresh}
    >
      <svg><use xlink:href="#iconRefresh"></use></svg>
    </button>

    <button
      type="button"
      class="block__icon block__icon--show b3-tooltips b3-tooltips__sw"
      aria-label={t("diff.toolbar.close")}
      onclick={actions.onClose}
    >
      <svg><use xlink:href="#iconClose"></use></svg>
    </button>
  </div>
</div>

<style lang="scss">
  .omnikit-diff-toolbar {
    position: fixed;
    top: 42px;
    left: 50%;
    transform: translateX(-50%);
    z-index: 205;
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 6px;
    max-width: calc(100vw - 32px);
    padding: 5px 10px;
    background: var(--b3-theme-surface);
    color: var(--b3-theme-on-surface);
    border: 1px solid var(--b3-border-color);
    border-radius: var(--b3-border-radius-b, 8px);
    box-shadow: var(--b3-dialog-shadow);
    font-size: 12px;
    user-select: none;
  }

  .omnikit-diff-toolbar__grip {
    cursor: grab;
    padding: 2px 3px;
    color: var(--b3-theme-on-surface-light, var(--b3-theme-on-surface));
    opacity: 0.7;
    touch-action: none;

    &:active {
      cursor: grabbing;
    }
  }

  .omnikit-diff-toolbar__dots {
    font-weight: 700;
    letter-spacing: -1px;
  }

  .omnikit-diff-toolbar__identities {
    display: flex;
    align-items: center;
    gap: 6px;
    min-width: 0;
  }

  .omnikit-diff-toolbar__doc {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    max-width: 150px;
    color: var(--b3-theme-on-background);
    font-weight: 500;
  }

  .omnikit-diff-toolbar__doc-title {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .omnikit-diff-toolbar__arrow {
    color: var(--b3-theme-on-surface);
    opacity: 0.75;
  }

  .omnikit-diff-toolbar__dot {
    flex: 0 0 8px;
    width: 8px;
    height: 8px;
    border-radius: 50%;
    background-color: var(--b3-theme-on-surface);

    &.dot--removed {
      background-color: var(--b3-theme-error);
    }

    &.dot--added {
      background-color: var(--b3-theme-success);
    }

    &.dot--modified {
      background-color: var(--b3-theme-primary);
    }

    &.dot--unresolved {
      background-color: var(--b3-theme-warning, var(--b3-theme-secondary));
    }
  }

  .omnikit-diff-toolbar__sep {
    width: 1px;
    height: 16px;
    background: var(--b3-border-color);
  }

  .omnikit-diff-toolbar__status {
    font-weight: 500;
    color: var(--b3-theme-on-background);
    white-space: nowrap;

    &.status--warning {
      color: var(--b3-theme-warning, var(--b3-theme-primary));
    }

    &.status--error {
      color: var(--b3-theme-error);
    }
  }

  .omnikit-diff-toolbar__chips {
    display: flex;
    align-items: center;
    gap: 3px;
  }

  .omnikit-diff-chip {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    margin: 0;
    padding: 2px 7px;
    border: 0;
    font-size: 12px;
    font-family: inherit;
    line-height: 18px;
  }

  .omnikit-diff-toolbar__actions {
    display: flex;
    align-items: center;
    gap: 3px;

    .block__icon[disabled] {
      opacity: 0.38;
      pointer-events: none;
    }
  }

  .omnikit-diff-toolbar__counter {
    min-width: 36px;
    text-align: center;
    font-variant-numeric: tabular-nums;
    color: var(--b3-theme-on-surface);
  }

  .omnikit-diff-toolbar__toggle {
    padding: 2px 8px;
    font-size: 12px;
    line-height: 18px;
    height: 24px;

    &.is-active {
      border-color: var(--b3-theme-primary);
      color: var(--b3-theme-primary);
      background: color-mix(in srgb, var(--b3-theme-primary) 10%, transparent);
    }
  }
</style>
