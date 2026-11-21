<script lang="ts">
  import { onMount, untrack } from "svelte";
  import { Dialog, openTab, showMessage } from "siyuan";
  import { isAbortError } from "../../../core/feedback/UiFeedback.ts";
  import { KernelClient } from "../../../core/host/KernelClient.ts";
  import { imageRecordsFor } from "../store/ImageCompressionRecordStore.ts";
  import { blockDOM, ReferenceService } from "../services/references.ts";
  import {
    checkAssetAvailability,
    locateAssetOccurrences,
    reconcileRecordPair,
    type OccurrenceItem,
    type UnsupportedReferenceItem,
  } from "../services/ImageReferences.ts";
  import { resolveImageOccurrence } from "../services/ImageOccurrenceResolver.ts";
  import { buildExpectedBlockDOM, normalizeBlockDOMForCompare } from "../services/SafeBlockWriter.ts";
  import { findLinkCandidates } from "../policy/dom.ts";
  import { sameAsset, trySource } from "../policy/source.ts";
  import type { FeatureContext } from "../../../core/framework/FeatureContext.ts";
  import type { AssetAvailability, CompressionRecord, OccurrenceTarget, OperationKind } from "../policy/contracts.ts";

  interface Props {
    context: FeatureContext;
    t: (key: string, values?: Record<string, string | number>) => string;
  }

  type DisplayStatus = AssetAvailability | "checking";

  let { context, t }: Props = $props();
  const { store, ready } = untrack(() => imageRecordsFor(context.plugin));
  const kernel = new KernelClient();
  const origin = typeof location !== "undefined" ? location.origin : "http://127.0.0.1:6806";
  const references = new ReferenceService(kernel, origin);

  let records = $state<CompressionRecord[]>([]);
  let assetStatuses = $state<Record<string, DisplayStatus>>({});
  let expanded = $state<{ path: string; mode: "original" | "compressed" } | null>(null);
  let occurrences = $state<OccurrenceItem[]>([]);
  let unsupportedRefs = $state<UnsupportedReferenceItem[]>([]);
  let loading = $state(false);
  let busy = $state(false);
  let message = $state("");
  let mounted = false;
  let lastLocateOk = false;
  let lastLocateComplete = false;

  let imageItems = $derived(occurrences.filter(item => item.target.kind !== "link"));
  let linkItems = $derived(occurrences.filter(item => item.target.kind === "link"));

  function format(key: string, values: Record<string, string | number>): string {
    return t(key, values);
  }

  function notifyDock(text: string, type: "info" | "error" = "info", timeout = 3000): void {
    if (context.feedback) {
      context.feedback.notify(text, type, { timeout });
    } else {
      showMessage(text, timeout, type);
    }
  }

  function previewSrc(path: string): string {
    const parsed = trySource(path, origin);
    return parsed?.kind === "asset" ? parsed.fetchURL : `/${path}`;
  }

  function badgeVariant(status: DisplayStatus | undefined): "checking" | "present" | "missing" | "unknown" {
    if (status === "checking") return "checking";
    if (status === "present") return "present";
    if (status === "missing-confirmed") return "missing";
    return "unknown";
  }

  function badgeTextKey(status: DisplayStatus | undefined): string {
    if (status === "checking") return "image.records.assetStatus.checking";
    if (status === "present") return "image.records.assetStatus.present";
    if (status === "missing-confirmed") return "image.records.assetStatus.missing";
    return "image.records.assetStatus.unknown";
  }

  function jumpToBlock(blockID: string): void {
    if (!blockID) return;
    void openTab({
      app: context.plugin.app,
      doc: {
        id: blockID,
        action: ["cb-get-hl", "cb-get-focus"],
      },
    });
  }

  let dockAbort: AbortController | undefined;

  async function verifyRecords(recordsToCheck: CompressionRecord[], signal?: AbortSignal): Promise<void> {
    for (let offset = 0; offset < recordsToCheck.length; offset += 3) {
      if (signal?.aborted) return;
      await Promise.all(recordsToCheck.slice(offset, offset + 3).map(async record => {
        try {
          const result = await reconcileRecordPair(
            record,
            (path, sig) => checkAssetAvailability(kernel, path, sig, { origin }),
            store,
            signal,
          );
          if (signal?.aborted) return;
          assetStatuses[record.originalPath] = result.original;
          assetStatuses[record.compressedPath] = result.compressed;
          if (result.removed && expanded?.path === record.originalPath) {
            expanded = null;
            occurrences = [];
            unsupportedRefs = [];
          }
        } catch (error) {
          if (signal?.aborted || isAbortError(error)) return;
          assetStatuses[record.originalPath] = "unknown";
          assetStatuses[record.compressedPath] = "unknown";
        }
      }));
    }
  }

  onMount(() => {
    const unsubscribe = store.store.subscribe(next => {
      const prevByOriginal = new Map(records.map(r => [r.originalPath, r.compressedPath]));
      const prevKeys = new Set(Object.keys(assetStatuses));
      const nextIndex = new Map<string, string>();
      const nextPaths = new Set<string>();
      for (const record of next.records) {
        nextIndex.set(record.originalPath, record.compressedPath);
        nextPaths.add(record.originalPath);
        nextPaths.add(record.compressedPath);
      }

      records = [...next.records];
      const nextStatuses: Record<string, DisplayStatus> = {};
      for (const path of Object.keys(assetStatuses)) {
        if (nextPaths.has(path)) {
          nextStatuses[path] = assetStatuses[path];
        }
      }

      const changedRecords: CompressionRecord[] = [];
      for (const record of next.records) {
        const origNew = !prevKeys.has(record.originalPath);
        const compChanged = prevByOriginal.get(record.originalPath) !== record.compressedPath || !prevKeys.has(record.compressedPath);
        if (origNew || compChanged) {
          changedRecords.push(record);
          if (origNew) nextStatuses[record.originalPath] = "checking";
          if (compChanged) nextStatuses[record.compressedPath] = "checking";
        }
      }
      assetStatuses = nextStatuses;
      if (expanded && !nextIndex.has(expanded.path)) {
        expanded = null;
        occurrences = [];
        unsupportedRefs = [];
      }
      if (mounted && changedRecords.length > 0) {
        void verifyRecords(changedRecords, dockAbort?.signal);
      }
    });
    mounted = true;
    const handleTabActivate = () => { if (!busy) void refresh(); };
    window.addEventListener("omnikit-dock-tab-activated", handleTabActivate);
    void refresh();
    return () => {
      dockAbort?.abort();
      unsubscribe();
      window.removeEventListener("omnikit-dock-tab-activated", handleTabActivate);
    };
  });

  async function refresh(): Promise<void> {
    dockAbort?.abort();
    dockAbort = new AbortController();
    const signal = dockAbort.signal;
    loading = true;
    message = "";
    try {
      await ready;
      if (signal.aborted) return;
      records = [...store.snapshot()];
      const snapshot = [...records];
      for (const record of snapshot) {
        assetStatuses[record.originalPath] = "checking";
        assetStatuses[record.compressedPath] = "checking";
      }
      await verifyRecords(snapshot, signal);
    } catch (error) {
      if (!signal.aborted && !isAbortError(error)) {
        message = t("image.records.loadFailed");
      }
    } finally {
      if (!signal.aborted) {
        loading = false;
      }
    }
  }

  async function locateOccurrences(
    record: CompressionRecord,
    mode: "original" | "compressed",
    source: "user_click" | "post_action" = "user_click",
  ): Promise<void> {
    expanded = { path: record.originalPath, mode };
    occurrences = [];
    unsupportedRefs = [];
    busy = true;
    lastLocateOk = false;
    lastLocateComplete = false;
    if (source === "user_click") {
      message = "";
    }
    const searchPath = mode === "original" ? record.originalPath : record.compressedPath;
    const signal = dockAbort?.signal;
    try {
      const located = await locateAssetOccurrences(kernel, origin, searchPath, t, signal);
      if (signal?.aborted) return;

      if (located.encryptedUnavailable) {
        lastLocateOk = false;
        lastLocateComplete = false;
        if (source === "user_click") {
          message = format("image.records.skippedNotebooks", { count: Math.max(1, located.skippedNotebooks.length) });
        }
        return;
      }

      occurrences = located.items;
      unsupportedRefs = located.unsupported;
      lastLocateOk = located.ok;
      lastLocateComplete = located.complete;

      const lookupWarnings = () => {
        const list: string[] = [];
        if (located.skippedNotebooks.length > 0) {
          list.push(format("image.records.skippedNotebooks", { count: located.skippedNotebooks.length }));
        }
        if (located.unavailableAttributeViews > 0 || located.metadataIncomplete) {
          list.push(t("image.records.incompleteLookup"));
        }
        return list.join(" ");
      };

      if (source === "user_click") {
        if (!located.items.length && !located.unsupported.length) {
          message = mode === "original"
            ? t("image.records.noOriginalReferences")
            : t("image.records.noCompressedReferences");
          const warnText = lookupWarnings();
          if (warnText) message = `${message} ${warnText}`;
        } else {
          const warnText = lookupWarnings();
          if (warnText) message = warnText;
        }
      } else {
        if (!located.items.length && !located.unsupported.length) {
          expanded = null;
          occurrences = [];
          unsupportedRefs = [];
        }
      }
    } catch (error) {
      if (!signal?.aborted && !isAbortError(error) && source === "user_click") {
        message = t("image.records.lookupFailed");
      }
    } finally {
      busy = false;
    }
  }

  async function toggleOriginalReferences(record: CompressionRecord): Promise<void> {
    if (expanded?.path === record.originalPath && expanded.mode === "original") {
      expanded = null;
      occurrences = [];
      unsupportedRefs = [];
      message = "";
      return;
    }
    await locateOccurrences(record, "original", "user_click");
  }

  async function locateRestoreOccurrences(record: CompressionRecord): Promise<void> {
    if ((assetStatuses[record.originalPath] ?? "unknown") !== "present") {
      return;
    }
    if (expanded?.path === record.originalPath && expanded.mode === "compressed") {
      expanded = null;
      occurrences = [];
      unsupportedRefs = [];
      message = "";
      return;
    }
    await locateOccurrences(record, "compressed", "user_click");
  }

  async function syncOperationAfterAction(record: CompressionRecord, resolvedOp: OperationKind, conflicts: number): Promise<void> {
    if (!lastLocateOk || dockAbort?.signal.aborted) return;
    const nextOp: OperationKind = lastLocateComplete && occurrences.length === 0 && conflicts === 0 ? resolvedOp : "incomplete";
    await store.markOperation(record.originalPath, record.compressedPath, nextOp).catch(() => undefined);
  }

  function resolveRefreshedTarget(
    dom: string,
    previous: OccurrenceTarget,
    expectedBlockDOM?: string,
  ): OccurrenceTarget | undefined {
    if (expectedBlockDOM !== undefined && normalizeBlockDOMForCompare(dom) !== expectedBlockDOM) {
      return undefined;
    }
    if (previous.kind !== "link") {
      return resolveImageOccurrence(dom, {
        rootID: previous.rootID,
        notebook: previous.notebook,
        blockID: previous.blockID,
        imageOrdinal: previous.imageOrdinal,
        oldPath: previous.oldPath,
      });
    }
    const template = document.createElement("template");
    template.innerHTML = dom;
    const roots = [...template.content.children].filter(el => el.getAttribute("data-node-id") === previous.blockID);
    if (template.content.children.length !== 1 || roots.length !== 1 || roots[0].querySelector("[data-node-id]")) {
      return undefined;
    }
    const candidates = findLinkCandidates(roots[0]);
    const selected = candidates[previous.imageOrdinal];
    if (!selected) return undefined;
    if (previous.attribute && selected.attribute !== previous.attribute) return undefined;
    if (selected.element.getAttribute(selected.attribute) !== previous.oldPath) return undefined;
    return { ...previous, baselineBlockDOM: dom };
  }

  async function applyOccurrenceAction(
    record: CompressionRecord,
    mode: "original" | "compressed",
    items: OccurrenceItem[],
  ): Promise<void> {
    if (!items.length) return;
    const isReplace = mode === "original";
    const expectedOldPath = isReplace ? record.originalPath : record.compressedPath;
    const nextPath = isReplace ? record.compressedPath : record.originalPath;
    const resultKey = isReplace ? "image.records.replaceResult" : "image.records.restoreResult";
    const countVar = isReplace ? "replaced" : "restored";
    const failKey = isReplace ? "image.records.lookupFailed" : "image.records.restoreFailed";
    const resolvedOp: OperationKind = isReplace ? "replaced" : "saved-only";

    busy = true;
    message = "";
    const signal = dockAbort?.signal;
    try {
      const targetAvail = await checkAssetAvailability(kernel, nextPath, signal);
      if (signal?.aborted) return;
      if (targetAvail !== "present") {
        throw new Error("Target asset is unavailable");
      }
      const current = store.snapshot().find(r => r.originalPath === record.originalPath && r.compressedPath === record.compressedPath);
      if (!current) throw new Error("Record changed");

      let changed = 0;
      let conflicts = 0;
      const dirtyBlocks = new Set<string>();
      const expectedBlockDOMs = new Map<string, string>();

      for (const item of items) {
        if (signal?.aborted) return;
        if (!sameAsset(item.target.oldPath, expectedOldPath, origin)) {
          conflicts++;
          continue;
        }
        let target = item.target;
        if (dirtyBlocks.has(target.blockID)) {
          const freshDOM = await blockDOM(kernel, target.blockID, target.notebook, signal);
          const refreshed = resolveRefreshedTarget(freshDOM, target, expectedBlockDOMs.get(target.blockID));
          if (!refreshed) {
            conflicts++;
            continue;
          }
          target = refreshed;
        }
        const res = await references.commitOccurrence(target, nextPath, signal);
        if (res === "aborted" || signal?.aborted) return;
        if (res === "replaced") {
          changed++;
          dirtyBlocks.add(target.blockID);
          const expected = buildExpectedBlockDOM(target, nextPath, origin);
          if (expected !== undefined) {
            expectedBlockDOMs.set(target.blockID, expected);
          } else {
            expectedBlockDOMs.delete(target.blockID);
          }
        } else {
          conflicts++;
        }
      }

      const msg = format(resultKey, { [countVar]: changed, conflicts });
      message = msg;
      notifyDock(msg, "info", 3000);

      // Isolate post_action refresh and record sync so failures never overwrite confirmed action feedback.
      try {
        await locateOccurrences(record, mode, "post_action");
        await syncOperationAfterAction(record, resolvedOp, conflicts);
      } catch (postError) {
        if (!signal?.aborted && !isAbortError(postError)) {
          context.logger.warn("操作后刷新引用状态失败", postError);
        }
      }
    } catch (error) {
      if (signal?.aborted || isAbortError(error)) return;
      const errText = t(failKey);
      message = errText;
      notifyDock(errText, "error", 3000);
    } finally {
      busy = false;
    }
  }

  function showManualCopyDialog(path: string): void {
    const dialog = new Dialog({
      title: t("image.records.title"),
      content: '<div class="b3-dialog__content"><p class="omnikit-manual-copy-label"></p><input class="b3-text-field omnikit-manual-copy-input" readonly /></div>',
      width: "min(520px, 92vw)",
    });
    const label = dialog.element.querySelector<HTMLElement>(".omnikit-manual-copy-label");
    const input = dialog.element.querySelector<HTMLInputElement>(".omnikit-manual-copy-input");
    if (label) label.textContent = t("image.records.copyManual");
    if (input) {
      input.value = path;
      input.onclick = () => input.select();
      input.focus();
      input.select();
    }
  }

  async function copyPath(path: string): Promise<void> {
    try {
      if (typeof navigator === "undefined" || !navigator.clipboard?.writeText) {
        throw new Error("Clipboard API unavailable");
      }
      await navigator.clipboard.writeText(path);
      message = t("image.records.copied");
      notifyDock(t("image.records.copied"), "info", 2000);
    } catch {
      message = t("image.records.copyFailed");
      showManualCopyDialog(path);
    }
  }

  async function removeRecord(record: CompressionRecord): Promise<void> {
    busy = true;
    message = "";
    try {
      await store.removeRecord(record.originalPath);
      if (expanded?.path === record.originalPath) {
        expanded = null;
        occurrences = [];
        unsupportedRefs = [];
      }
      records = [...store.snapshot()];
      message = t("image.records.removed");
    } catch {
      message = t("image.records.removeFailed");
    } finally {
      busy = false;
    }
  }
</script>

<section class="image-records" aria-busy={busy || loading}>
  <div class="image-records__hero">
    <div class="image-records__hero-icon-wrapper">
      <svg class="image-records__hero-icon" viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
        <rect x="3" y="3" width="18" height="18" rx="2" ry="2"/>
        <circle cx="8.5" cy="8.5" r="1.5"/>
        <polyline points="21 15 16 10 5 21"/>
      </svg>
    </div>
    <div class="image-records__hero-content">
      <h2 class="image-records__hero-title">{t("dock.heroTitle")}</h2>
      <p class="image-records__hero-subtitle">{t("dock.heroSubtitle")}</p>
    </div>
  </div>

  <header class="image-records__header">
    <div class="image-records__title-group">
      <h3 class="image-records__title">{t("image.records.title")}</h3>
      <span class="image-records__count">{records.length}</span>
    </div>
    <button
      type="button"
      class="b3-button b3-button--outline image-records__refresh-btn"
      disabled={busy || loading}
      onclick={() => refresh()}
      title={t("image.records.refresh")}
    >
      {#if loading}
        <span class="image-records__spinner" aria-hidden="true"></span>
      {/if}
      {t("image.records.refresh")}
    </button>
  </header>

  {#if message}
    <div class="image-records__banner" role="status">
      <span>{message}</span>
    </div>
  {/if}

  {#if loading && records.length === 0}
    <div class="image-records__loading">
      <span class="image-records__spinner" aria-hidden="true"></span>
      <span>{t("image.records.loading")}</span>
    </div>
  {:else if records.length === 0}
    <div class="image-records__empty-card">
      <svg class="image-records__empty-icon" viewBox="0 0 24 24" width="40" height="40" fill="none" stroke="currentColor" stroke-width="1.5">
        <rect x="3" y="3" width="18" height="18" rx="3" ry="3"/>
        <circle cx="8.5" cy="8.5" r="1.5"/>
        <polyline points="21 15 16 10 5 21"/>
      </svg>
      <p class="image-records__empty-text">{t("image.records.empty")}</p>
    </div>
  {:else}
    <ul class="image-records__list">
      {#each records as record (record.originalPath)}
        {@const origStatus = assetStatuses[record.originalPath] ?? "checking"}
        {@const compStatus = assetStatuses[record.compressedPath] ?? "checking"}
        <li class="image-records__card">
          <div class="image-records__card-preview">
            <img
              class="image-records__img"
              src={previewSrc(record.compressedPath)}
              alt={t("image.records.previewAlt")}
              loading="lazy"
            />
          </div>

          <div class="image-records__card-body">
            <div class="image-records__row">
              <span class="image-records__label">{t("image.records.original")}</span>
              <button
                type="button"
                class="image-records__path-btn"
                title={t("image.records.clickToCopy")}
                onclick={() => copyPath(record.originalPath)}
              >
                <code class="image-records__path">{record.originalPath}</code>
                <svg class="image-records__copy-icon" viewBox="0 0 16 16" width="12" height="12" fill="currentColor">
                  <path d="M0 6.75C0 5.784.784 5 1.75 5h1.5a.75.75 0 0 1 0 1.5h-1.5a.25.25 0 0 0-.25.25v7.5c0 .138.112.25.25.25h7.5a.25.25 0 0 0 .25-.25v-1.5a.75.75 0 0 1 1.5 0v1.5A1.75 1.75 0 0 1 9.25 16h-7.5A1.75 1.75 0 0 1 0 14.25Z" />
                  <path d="M5 1.75C5 .784 5.784 0 6.75 0h7.5C15.216 0 16 .784 16 1.75v7.5A1.75 1.75 0 0 1 14.25 11h-7.5A1.75 1.75 0 0 1 5 9.25Zm1.75-.25a.25.25 0 0 0-.25.25v7.5c0 .138.112.25.25.25h7.5a.25.25 0 0 0 .25-.25v-7.5a.25.25 0 0 0-.25-.25Z" />
                </svg>
              </button>
              <span
                class={`image-records__badge image-records__badge--${badgeVariant(origStatus)}`}
                title={t("image.records.originalStatus")}
              >
                {#if origStatus === "checking"}
                  <span class="image-records__spinner image-records__spinner--small" aria-hidden="true"></span>
                {/if}
                {t(badgeTextKey(origStatus))}
              </span>
            </div>

            <div class="image-records__row">
              <span class="image-records__label">{t("image.records.compressed")}</span>
              <button
                type="button"
                class="image-records__path-btn"
                title={t("image.records.clickToCopy")}
                onclick={() => copyPath(record.compressedPath)}
              >
                <code class="image-records__path">{record.compressedPath}</code>
                <svg class="image-records__copy-icon" viewBox="0 0 16 16" width="12" height="12" fill="currentColor">
                  <path d="M0 6.75C0 5.784.784 5 1.75 5h1.5a.75.75 0 0 1 0 1.5h-1.5a.25.25 0 0 0-.25.25v7.5c0 .138.112.25.25.25h7.5a.25.25 0 0 0 .25-.25v-1.5a.75.75 0 0 1 1.5 0v1.5A1.75 1.75 0 0 1 9.25 16h-7.5A1.75 1.75 0 0 1 0 14.25Z" />
                  <path d="M5 1.75C5 .784 5.784 0 6.75 0h7.5C15.216 0 16 .784 16 1.75v7.5A1.75 1.75 0 0 1 14.25 11h-7.5A1.75 1.75 0 0 1 5 9.25Zm1.75-.25a.25.25 0 0 0-.25.25v7.5c0 .138.112.25.25.25h7.5a.25.25 0 0 0 .25-.25v-7.5a.25.25 0 0 0-.25-.25Z" />
                </svg>
              </button>
              <span
                class={`image-records__badge image-records__badge--${badgeVariant(compStatus)}`}
                title={t("image.records.compressedStatus")}
              >
                {#if compStatus === "checking"}
                  <span class="image-records__spinner image-records__spinner--small" aria-hidden="true"></span>
                {/if}
                {t(badgeTextKey(compStatus))}
              </span>
            </div>

            <div class="image-records__meta">
              <span class="image-records__meta-item">
                {new Date(record.updatedAt).toLocaleString()}
              </span>
              <span class="image-records__meta-tag">
                {t(`image.records.operation.${record.lastOperation}`)}
              </span>
            </div>

            <div class="image-records__actions">
              <button
                type="button"
                class="b3-button b3-button--outline"
                disabled={busy || origStatus !== "present"}
                onclick={() => locateRestoreOccurrences(record)}
              >
                {expanded?.path === record.originalPath && expanded.mode === "compressed"
                  ? t("image.records.hideReferences")
                  : t("image.records.findCompressedReferences")}
              </button>
              <button
                type="button"
                class="b3-button b3-button--outline"
                disabled={busy}
                onclick={() => toggleOriginalReferences(record)}
              >
                {expanded?.path === record.originalPath && expanded.mode === "original"
                  ? t("image.records.hideReferences")
                  : t("image.records.findOriginalReferences")}
              </button>
              <button
                type="button"
                class="b3-button b3-button--cancel"
                disabled={busy}
                onclick={() => removeRecord(record)}
              >
                {t("image.records.remove")}
              </button>
            </div>

            {#if expanded?.path === record.originalPath}
              <div class="image-records__references">
                <div class="image-records__ref-header">
                  <h4 class="image-records__ref-title">
                    {expanded.mode === "original"
                      ? t("image.records.originalReferences")
                      : t("image.records.compressedReferences")}
                  </h4>
                  <p class="image-records__ref-desc">
                    {expanded.mode === "original"
                      ? t("image.records.originalReferencesDesc")
                      : t("image.records.compressedReferencesDesc")}
                  </p>
                </div>

                {#if imageItems.length}
                  <div class="image-records__ref-group">
                    <span class="image-records__ref-group-title">{t("image.records.imageRefs", { count: imageItems.length })}</span>
                    <div class="image-records__occurrences">
                      {#each imageItems as item (item.key)}
                        <div class="image-records__occurrence-row">
                          <button
                            type="button"
                            class="image-records__jump-btn"
                            title={item.label}
                            onclick={() => jumpToBlock(item.target.blockID)}
                          >
                            <svg class="image-records__jump-icon" viewBox="0 0 16 16" width="12" height="12" fill="currentColor">
                              <path d="M4.75 3a.75.75 0 0 0-.75.75v8.5c0 .414.336.75.75.75h6.5a.75.75 0 0 0 .75-.75v-8.5a.75.75 0 0 0-.75-.75h-6.5ZM2.5 3.75A2.25 2.25 0 0 1 4.75 1.5h6.5A2.25 2.25 0 0 1 13.5 3.75v8.5a2.25 2.25 0 0 1-2.25 2.25h-6.5A2.25 2.25 0 0 1 2.5 12.25v-8.5Z"/>
                            </svg>
                            <span class="image-records__jump-text">{item.label}</span>
                          </button>
                          <button
                            type="button"
                            class="b3-button b3-button--outline image-records__action-btn"
                            disabled={busy}
                            onclick={() => expanded && applyOccurrenceAction(record, expanded.mode, [item])}
                          >
                            {expanded.mode === "original" ? t("image.records.replaceThis") : t("image.records.restoreThis")}
                          </button>
                        </div>
                      {/each}
                    </div>
                  </div>
                {/if}

                {#if linkItems.length}
                  <div class="image-records__ref-group">
                    <span class="image-records__ref-group-title">{t("image.records.linkRefs", { count: linkItems.length })}</span>
                    <div class="image-records__occurrences">
                      {#each linkItems as item (item.key)}
                        <div class="image-records__occurrence-row">
                          <button
                            type="button"
                            class="image-records__jump-btn"
                            title={item.label}
                            onclick={() => jumpToBlock(item.target.blockID)}
                          >
                            <svg class="image-records__jump-icon" viewBox="0 0 16 16" width="12" height="12" fill="currentColor">
                              <path d="M4.75 3a.75.75 0 0 0-.75.75v8.5c0 .414.336.75.75.75h6.5a.75.75 0 0 0 .75-.75v-8.5a.75.75 0 0 0-.75-.75h-6.5ZM2.5 3.75A2.25 2.25 0 0 1 4.75 1.5h6.5A2.25 2.25 0 0 1 13.5 3.75v8.5a2.25 2.25 0 0 1-2.25 2.25h-6.5A2.25 2.25 0 0 1 2.5 12.25v-8.5Z"/>
                            </svg>
                            <span class="image-records__jump-text">{item.label}</span>
                          </button>
                          <button
                            type="button"
                            class="b3-button b3-button--outline image-records__action-btn"
                            disabled={busy}
                            onclick={() => expanded && applyOccurrenceAction(record, expanded.mode, [item])}
                          >
                            {expanded.mode === "original" ? t("image.records.replaceThis") : t("image.records.restoreThis")}
                          </button>
                        </div>
                      {/each}
                    </div>
                  </div>
                {/if}

                {#if unsupportedRefs.length}
                  <div class="image-records__ref-group">
                    <span class="image-records__ref-group-title">{t("image.records.unsupportedRefs", { count: unsupportedRefs.length })}</span>
                    <div class="image-records__occurrences">
                      {#each unsupportedRefs as item (item.key)}
                        <div class="image-records__occurrence-row">
                          <button
                            type="button"
                            class="image-records__jump-btn"
                            title={item.label}
                            onclick={() => jumpToBlock(item.blockID || item.rootID)}
                          >
                            <svg class="image-records__jump-icon" viewBox="0 0 16 16" width="12" height="12" fill="currentColor">
                              <path d="M4.75 3a.75.75 0 0 0-.75.75v8.5c0 .414.336.75.75.75h6.5a.75.75 0 0 0 .75-.75v-8.5a.75.75 0 0 0-.75-.75h-6.5ZM2.5 3.75A2.25 2.25 0 0 1 4.75 1.5h6.5A2.25 2.25 0 0 1 13.5 3.75v8.5a2.25 2.25 0 0 1-2.25 2.25h-6.5A2.25 2.25 0 0 1 2.5 12.25v-8.5Z"/>
                            </svg>
                            <span class="image-records__jump-text">{item.label}</span>
                          </button>
                        </div>
                      {/each}
                    </div>
                  </div>
                {/if}

                {#if occurrences.length}
                  <div class="image-records__batch-actions">
                    <button
                      type="button"
                      class="b3-button"
                      disabled={busy || !occurrences.length}
                      onclick={() => expanded && applyOccurrenceAction(record, expanded.mode, occurrences)}
                    >
                      {expanded.mode === "original" ? t("image.records.replaceAll") : t("image.records.restoreAll")}
                    </button>
                  </div>
                {:else if !busy && !unsupportedRefs.length}
                  <p class="image-records__empty-refs">{expanded?.mode === "original" ? t("image.records.noOriginalReferences") : t("image.records.noCompressedReferences")}</p>
                {/if}
              </div>
            {/if}
          </div>
        </li>
      {/each}
    </ul>
  {/if}
</section>

<style>
  .image-records {
    display: flex;
    flex-direction: column;
    gap: 12px;
    padding: 2px;
  }
  .image-records__hero {
    display: flex;
    align-items: center;
    gap: 12px;
    min-height: 52px;
    max-height: 56px;
    padding: 8px 12px;
    background: linear-gradient(135deg, color-mix(in srgb, var(--b3-theme-primary) 8%, transparent) 0%, color-mix(in srgb, var(--b3-theme-primary) 2%, transparent) 100%);
    border: 1px solid color-mix(in srgb, var(--b3-theme-primary) 15%, transparent);
    border-radius: 8px;
    box-sizing: border-box;
  }
  .image-records__hero-icon-wrapper {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 32px;
    height: 32px;
    border-radius: 6px;
    background: color-mix(in srgb, var(--b3-theme-primary) 12%, transparent);
    color: var(--b3-theme-primary);
    flex-shrink: 0;
  }
  .image-records__hero-content {
    display: flex;
    flex-direction: column;
    gap: 2px;
    min-width: 0;
  }
  .image-records__hero-title {
    margin: 0;
    font-size: 13px;
    font-weight: 700;
    color: var(--b3-theme-on-background);
    line-height: 1.25;
  }
  .image-records__hero-subtitle {
    margin: 0;
    font-size: 11px;
    color: var(--b3-theme-on-surface);
    opacity: 0.75;
    line-height: 1.2;
  }
  .image-records__header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
  }
  .image-records__title-group {
    display: flex;
    align-items: center;
    gap: 8px;
  }
  .image-records__title {
    margin: 0;
    font-size: 14px;
    font-weight: 600;
  }
  .image-records__count {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    min-width: 18px;
    height: 18px;
    padding: 0 6px;
    font-size: 11px;
    border-radius: 9px;
    background: var(--b3-theme-surface-lighter);
    color: var(--b3-theme-on-surface);
  }
  .image-records__refresh-btn {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    font-size: 12px;
    padding: 3px 8px;
  }
  .image-records__banner {
    padding: 8px 12px;
    border-radius: 6px;
    background: var(--b3-theme-surface-lighter);
    font-size: 12px;
    color: var(--b3-theme-primary);
  }
  .image-records__loading {
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 8px;
    padding: 24px;
    color: var(--b3-theme-on-surface);
    font-size: 13px;
  }
  .image-records__empty-card {
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 10px;
    padding: 32px 16px;
    border: 1px dashed var(--b3-theme-surface-lighter);
    border-radius: 8px;
    color: var(--b3-theme-on-surface);
    opacity: 0.7;
    text-align: center;
  }
  .image-records__empty-text {
    margin: 0;
    font-size: 13px;
  }
  .image-records__list {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: 12px;
  }
  .image-records__card {
    display: flex;
    flex-direction: column;
    gap: 10px;
    padding: 12px;
    background: var(--b3-theme-surface);
    border: 1px solid var(--b3-theme-surface-lighter);
    border-radius: 8px;
    box-shadow: 0 1px 3px color-mix(in srgb, var(--b3-theme-on-background) 6%, transparent);
  }
  .image-records__card-preview {
    display: flex;
    align-items: center;
    justify-content: center;
    max-height: 140px;
    background: var(--b3-theme-background);
    border-radius: 6px;
    overflow: hidden;
  }
  .image-records__img {
    max-width: 100%;
    max-height: 140px;
    object-fit: contain;
  }
  .image-records__card-body {
    display: flex;
    flex-direction: column;
    gap: 8px;
  }
  .image-records__row {
    display: flex;
    align-items: center;
    gap: 6px;
    font-size: 12px;
    min-width: 0;
  }
  .image-records__label {
    flex-shrink: 0;
    color: var(--b3-theme-on-surface);
    opacity: 0.75;
    font-size: 11px;
    width: 48px;
  }
  .image-records__path-btn {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    flex: 1;
    min-width: 0;
    padding: 2px 6px;
    background: var(--b3-theme-surface-lighter);
    border: 1px solid transparent;
    border-radius: 4px;
    cursor: pointer;
    text-align: left;
    transition: all 0.15s ease;
  }
  .image-records__path-btn:hover {
    border-color: var(--b3-theme-primary);
    background: var(--b3-theme-background);
  }
  .image-records__path {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    font-family: var(--b3-font-family-code);
    font-size: 11px;
    color: var(--b3-theme-primary);
  }
  .image-records__copy-icon {
    flex-shrink: 0;
    opacity: 0.6;
  }
  .image-records__path-btn:hover .image-records__copy-icon {
    opacity: 1;
    color: var(--b3-theme-primary);
  }
  .image-records__badge {
    flex-shrink: 0;
    display: inline-flex;
    align-items: center;
    gap: 3px;
    padding: 1px 6px;
    border-radius: 4px;
    font-size: 11px;
    font-weight: 500;
  }
  .image-records__badge--present {
    background: color-mix(in srgb, var(--b3-theme-primary) 12%, transparent);
    color: var(--b3-theme-primary);
  }
  .image-records__badge--missing {
    background: color-mix(in srgb, var(--b3-theme-error) 12%, transparent);
    color: var(--b3-theme-error);
  }
  .image-records__badge--checking {
    background: color-mix(in srgb, var(--b3-theme-secondary) 12%, transparent);
    color: var(--b3-theme-secondary);
  }
  .image-records__badge--unknown {
    background: var(--b3-theme-surface-lighter);
    color: var(--b3-theme-on-surface);
    opacity: 0.7;
  }
  .image-records__spinner {
    display: inline-block;
    width: 12px;
    height: 12px;
    border: 2px solid currentColor;
    border-right-color: transparent;
    border-radius: 50%;
    animation: image-records-spin 0.75s linear infinite;
  }
  .image-records__spinner--small {
    width: 9px;
    height: 9px;
    border-width: 1.5px;
  }
  @keyframes image-records-spin {
    to { transform: rotate(360deg); }
  }
  .image-records__meta {
    display: flex;
    align-items: center;
    justify-content: space-between;
    font-size: 11px;
    color: var(--b3-theme-on-surface);
    opacity: 0.65;
    padding: 2px 0;
  }
  .image-records__meta-tag {
    background: var(--b3-theme-surface-lighter);
    padding: 1px 6px;
    border-radius: 3px;
  }
  .image-records__actions {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 6px;
    margin-top: 4px;
  }
  .image-records__actions button {
    font-size: 11px;
    padding: 3px 8px;
  }
  .image-records__references {
    display: flex;
    flex-direction: column;
    gap: 6px;
    padding: 8px;
    margin-top: 6px;
    background: var(--b3-theme-background);
    border-radius: 6px;
  }
  .image-records__ref-header {
    display: flex;
    flex-direction: column;
    gap: 2px;
  }
  .image-records__ref-title {
    margin: 0;
    font-size: 12px;
    font-weight: 600;
  }
  .image-records__ref-desc {
    margin: 0;
    font-size: 11px;
    color: var(--b3-theme-on-surface);
    opacity: 0.7;
  }
  .image-records__ref-group {
    display: flex;
    flex-direction: column;
    gap: 4px;
    margin-top: 4px;
  }
  .image-records__ref-group-title {
    font-size: 11px;
    font-weight: 600;
    color: var(--b3-theme-on-surface);
    opacity: 0.8;
  }
  .image-records__occurrences {
    display: flex;
    flex-direction: column;
    gap: 4px;
    margin-top: 2px;
  }
  .image-records__occurrence-row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
    padding: 2px 0;
  }
  .image-records__jump-btn {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    flex: 1;
    min-width: 0;
    background: transparent;
    border: none;
    padding: 3px 6px;
    border-radius: 4px;
    cursor: pointer;
    text-align: left;
    color: var(--b3-theme-on-surface);
    transition: background 0.15s ease, color 0.15s ease;
  }
  .image-records__jump-btn:hover {
    background: var(--b3-theme-surface-lighter);
    color: var(--b3-theme-primary);
  }
  .image-records__jump-icon {
    flex-shrink: 0;
    opacity: 0.7;
  }
  .image-records__jump-text {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    font-size: 11px;
  }
  .image-records__action-btn {
    flex-shrink: 0;
    font-size: 11px;
    padding: 2px 8px;
  }
  .image-records__batch-actions {
    display: flex;
    justify-content: flex-end;
    margin-top: 6px;
  }
  .image-records__batch-actions button {
    font-size: 11px;
    padding: 3px 10px;
  }
  .image-records__empty-refs {
    margin: 4px 0 0 0;
    font-size: 11px;
    color: var(--b3-theme-on-surface);
    opacity: 0.7;
  }
</style>
