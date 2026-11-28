<script lang="ts">
  import { onMount, untrack } from "svelte";
  import { openTab } from "siyuan";
  import { isAbortError } from "../../../core/feedback/UiFeedback.ts";
  import { KernelClient } from "../../../core/host/KernelClient.ts";
  import { imageRecordsFor, isRemoteRecordSource } from "../store/ImageCompressionRecordStore.ts";
  import { ReferenceService } from "../services/SafeBlockWriter.ts";
  import { checkAssetAvailability, reconcileRecordPair } from "../services/assetAvailability.ts";
  import {
    locateAssetOccurrences,
    type OccurrenceItem,
    type UnsupportedReferenceItem,
  } from "../services/ImageReferences.ts";
  import { sameSource, trySource } from "../policy/source.ts";
  import type { FeatureContext } from "../../../core/framework/FeatureContext.ts";
  import type { AssetAvailability, CompressionRecord, OperationKind } from "../policy/contracts.ts";
  import { openCopyablePathDialog, type ImageTaskScope } from "./ImageTaskUI.ts";
  import ImageRecordCard from "./ImageRecordCard.svelte";

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
  let busyDepth = $state(0);
  let busy = $derived(busyDepth > 0);
  let message = $state("");
  let initialized = false;
  let lastLocateOk = false;
  let lastLocateComplete = false;
  let unmounted = false;

  const dockDisposers = new Set<() => void>();
  const dockScope: ImageTaskScope = {
    get active() { return !unmounted; },
    own(dispose: () => void) {
      dockDisposers.add(dispose);
      return () => { dockDisposers.delete(dispose); };
    },
  };

  function format(key: string, values: Record<string, string | number>): string {
    return t(key, values);
  }

  function notifyDock(text: string, type: "info" | "error" = "info", timeout = 3000): void {
    context.feedback.notify(text, type, { timeout });
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
  const recordControllers = new Map<string, AbortController>();

  async function withBusy<T>(work: () => Promise<T>): Promise<T> {
    busyDepth += 1;
    try {
      return await work();
    } finally {
      busyDepth -= 1;
    }
  }

  function isCurrentPair(record: CompressionRecord): boolean {
    return records.some(
      r => r.originalPath === record.originalPath && r.compressedPath === record.compressedPath,
    );
  }

  function cancelRecordVerify(originalPath: string): void {
    recordControllers.get(originalPath)?.abort();
    recordControllers.delete(originalPath);
  }

  function cancelAllRecordVerifications(): void {
    for (const ctrl of recordControllers.values()) ctrl.abort();
    recordControllers.clear();
  }

  async function verifyRecords(recordsToCheck: CompressionRecord[], signal?: AbortSignal): Promise<void> {
    for (let offset = 0; offset < recordsToCheck.length; offset += 3) {
      if (signal?.aborted) return;
      await Promise.all(recordsToCheck.slice(offset, offset + 3).map(async record => {
        if (!isCurrentPair(record)) return;
        cancelRecordVerify(record.originalPath);
        const itemAbort = new AbortController();
        const onParentAbort = () => itemAbort.abort();
        signal?.addEventListener("abort", onParentAbort, { once: true });
        recordControllers.set(record.originalPath, itemAbort);
        try {
          const result = await reconcileRecordPair(
            record,
            (path, sig) => checkAssetAvailability(kernel, path, sig, { origin }),
            store,
            itemAbort.signal,
          );
          // compareAndRemove 落盘会同步触发 store.subscribe 清理 assetStatuses/expanded 并中止 itemAbort，须优先处理
          if (result.removed) {
            context.logger?.debug?.("压缩记录因资源确认缺失已自动清理", {
              originalPath: record.originalPath,
              original: result.original,
              compressed: result.compressed,
            });
            return;
          }
          if (itemAbort.signal.aborted) return;
          if (!isCurrentPair(record)) return;
          if (!isRemoteRecordSource(record.originalPath)) {
            assetStatuses[record.originalPath] = result.original;
          }
          assetStatuses[record.compressedPath] = result.compressed;
        } catch (error) {
          if (itemAbort.signal.aborted || isAbortError(error)) return;
          context.logger?.debug?.("核验记录资源可用性失败，回退未知状态", {
            originalPath: record.originalPath,
            compressedPath: record.compressedPath,
            error,
          });
          if (isCurrentPair(record)) {
            if (!isRemoteRecordSource(record.originalPath)) {
              assetStatuses[record.originalPath] = "unknown";
            }
            assetStatuses[record.compressedPath] = "unknown";
          }
        } finally {
          signal?.removeEventListener("abort", onParentAbort);
          if (recordControllers.get(record.originalPath) === itemAbort) {
            recordControllers.delete(record.originalPath);
          }
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
        if (!isRemoteRecordSource(record.originalPath)) {
          nextPaths.add(record.originalPath);
        }
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
        const isRemote = isRemoteRecordSource(record.originalPath);
        const origNew = !isRemote && !prevKeys.has(record.originalPath);
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
      for (const [prevOrig, prevComp] of prevByOriginal) {
        if (nextIndex.get(prevOrig) !== prevComp) {
          cancelRecordVerify(prevOrig);
        }
      }
      if (initialized && changedRecords.length > 0) {
        void verifyRecords(changedRecords, dockAbort?.signal);
      }
    });
    const handleTabActivate = () => { if (!busy && !loading) void refresh(); };
    window.addEventListener("omnikit-dock-tab-activated", handleTabActivate);
    void refresh();
    return () => {
      unmounted = true;
      for (const dispose of [...dockDisposers]) dispose();
      dockDisposers.clear();
      cancelAllRecordVerifications();
      dockAbort?.abort();
      unsubscribe();
      window.removeEventListener("omnikit-dock-tab-activated", handleTabActivate);
    };
  });

  async function refresh(): Promise<void> {
    cancelAllRecordVerifications();
    dockAbort?.abort();
    dockAbort = new AbortController();
    const signal = dockAbort.signal;
    loading = true;
    message = "";
    try {
      try {
        await ready;
      } finally {
        if (!signal.aborted) {
          initialized = true;
        }
      }
      if (signal.aborted) return;
      records = [...store.snapshot()];
      const snapshot = [...records];
      for (const record of snapshot) {
        if (!isRemoteRecordSource(record.originalPath)) {
          assetStatuses[record.originalPath] = "checking";
        }
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
    await withBusy(async () => {
      expanded = { path: record.originalPath, mode };
      occurrences = [];
      unsupportedRefs = [];
      lastLocateOk = false;
      lastLocateComplete = false;
      if (source === "user_click") {
        message = "";
      }
      const searchPath = mode === "original" ? record.originalPath : record.compressedPath;
      const compressedSource = mode === "original" && isRemoteRecordSource(record.originalPath)
        ? trySource(record.compressedPath, origin)
        : undefined;
      const scopeBox = compressedSource?.kind === "asset" ? compressedSource.box : undefined;
      const signal = dockAbort?.signal;
      try {
        const located = await locateAssetOccurrences(
          kernel,
          origin,
          searchPath,
          t,
          signal,
          scopeBox ? { scopeBox } : undefined,
        );
        if (signal?.aborted) return;

        if (located.encryptedUnavailable) {
          context.logger?.debug?.("定位资源引用受限：加密笔记本不可用", {
            mode,
            source,
            skippedNotebooks: located.skippedNotebooks.length,
          });
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
          context.logger?.debug?.("定位资源引用失败", { mode, source, error });
          message = t("image.records.lookupFailed");
        } else if (!signal?.aborted && !isAbortError(error)) {
          context.logger?.debug?.("定位资源引用失败", { mode, source, error });
        }
      }
    });
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
    if (!isRemoteRecordSource(record.originalPath) && (assetStatuses[record.originalPath] ?? "unknown") !== "present") {
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
    if (!lastLocateOk || dockAbort?.signal.aborted) {
      context.logger?.debug?.("跳过同步压缩记录操作状态", {
        lastLocateOk,
        aborted: Boolean(dockAbort?.signal.aborted),
      });
      return;
    }
    const nextOp: OperationKind = lastLocateComplete && occurrences.length === 0 && conflicts === 0 ? resolvedOp : "incomplete";
    if (nextOp === "incomplete") {
      context.logger?.debug?.("压缩记录操作后仍为未完成状态", {
        resolvedOp,
        lastLocateComplete,
        remainingOccurrences: occurrences.length,
        conflicts,
      });
    }
    await store.markOperation(record.originalPath, record.compressedPath, nextOp).catch(err => {
      context.logger?.debug?.("持久化压缩记录操作状态失败", err);
    });
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

    await withBusy(async () => {
      message = "";
      const signal = dockAbort?.signal;
      try {
        if (!isRemoteRecordSource(nextPath)) {
          const targetAvail = await checkAssetAvailability(kernel, nextPath, signal, { origin });
          if (signal?.aborted) return;
          if (targetAvail !== "present") {
            throw new Error("Target asset is unavailable");
          }
        }
        const current = store.snapshot().find(r => r.originalPath === record.originalPath && r.compressedPath === record.compressedPath);
        if (!current) throw new Error("Record changed");

        let changed = 0;
        let conflicts = 0;

        for (const item of items) {
          if (signal?.aborted) return;
          if (!sameSource(item.target.oldPath, expectedOldPath, origin)) {
            context.logger?.debug?.("记录面板引用路径已变化，计入冲突", {
              blockID: item.target.blockID,
              imageOrdinal: item.target.imageOrdinal,
            });
            conflicts++;
            continue;
          }
          const target = item.target;
          const res = await references.commitOccurrence(target, nextPath, signal);
          if (res === "aborted" || signal?.aborted) return;
          if (res === "replaced") {
            changed++;
          } else {
            context.logger?.debug?.("记录面板单条引用写回未替换", {
              blockID: target.blockID,
              imageOrdinal: target.imageOrdinal,
              result: res,
            });
            conflicts++;
          }
        }

        const mainMsg = format(resultKey, { [countVar]: changed });
        const msg = conflicts > 0
          ? `${mainMsg}${format("image.records.resultConflicts", { conflicts })}`
          : mainMsg;
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
      }
    });
  }

  function showManualCopyDialog(path: string): void {
    openCopyablePathDialog(dockScope, {
      title: t("image.records.title"),
      reasonText: t("image.records.copyManual"),
      path,
      width: "min(520px, 92vw)",
    });
  }

  async function copyPath(path: string): Promise<void> {
    if (await context.feedback.copyable(path, t("image.records.copied"))) {
      message = t("image.records.copied");
      return;
    }
    message = t("image.records.copyFailed");
    showManualCopyDialog(path);
  }

  async function removeRecord(record: CompressionRecord): Promise<void> {
    await withBusy(async () => {
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
      }
    });
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
        <ImageRecordCard
          {record}
          {origin}
          origStatus={assetStatuses[record.originalPath] ?? "checking"}
          compStatus={assetStatuses[record.compressedPath] ?? "checking"}
          expandedMode={expanded?.path === record.originalPath ? expanded.mode : null}
          {occurrences}
          {unsupportedRefs}
          {busy}
          {t}
          onCopyPath={path => copyPath(path)}
          onToggleOriginalReferences={rec => toggleOriginalReferences(rec)}
          onLocateRestoreOccurrences={rec => locateRestoreOccurrences(rec)}
          onRemoveRecord={rec => removeRecord(rec)}
          onJumpToBlock={blockID => jumpToBlock(blockID)}
          onApplyOccurrenceAction={(rec, mode, items) => applyOccurrenceAction(rec, mode, items)}
        />
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
  .image-records__spinner {
    display: inline-block;
    width: 12px;
    height: 12px;
    border: 2px solid currentColor;
    border-right-color: transparent;
    border-radius: 50%;
    animation: image-records-spin 0.75s linear infinite;
  }
  @keyframes image-records-spin {
    to { transform: rotate(360deg); }
  }
</style>
