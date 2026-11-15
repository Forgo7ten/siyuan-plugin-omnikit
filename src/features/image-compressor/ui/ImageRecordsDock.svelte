<script lang="ts">
  import { onMount, untrack } from "svelte";
  import { openTab, showMessage } from "siyuan";
  import { KernelClient, KernelRequestError } from "../../../core/host/KernelClient.ts";
  import { imageRecordsFor } from "../store/ImageCompressionRecordStore.ts";
  import { ReferenceService } from "../services/references.ts";
  import type { FeatureContext } from "../../../core/framework/FeatureContext.ts";
  import type { CompressionRecord, OccurrenceTarget } from "../policy/contracts.ts";

  interface LocatedAssetReference {
    type: string;
    rootID: string;
    notebook?: string;
    blockID?: string;
    reference: string;
    relinkable: boolean;
    reason?: string;
  }
  interface Props {
    context: FeatureContext;
    t: (key: string, values?: Record<string, string | number>) => string;
  }
  interface OccurrenceItem {
    key: string;
    label: string;
    target: OccurrenceTarget;
  }

  let { context, t }: Props = $props();
  const { store, ready } = untrack(() => imageRecordsFor(context.plugin));
  const kernel = new KernelClient();
  const references = new ReferenceService(kernel, location.origin);

  let records = $state<CompressionRecord[]>([]);
  let assetStatuses = $state<Record<string, "checking" | "present" | "missing" | "unknown">>({});
  let expanded = $state<{ path: string; mode: "original" | "compressed" } | null>(null);
  let occurrences = $state<OccurrenceItem[]>([]);
  let loading = $state(false);
  let busy = $state(false);
  let message = $state("");
  let mounted = false;

  function format(key: string, values: Record<string, string | number>): string {
    return t(key, values);
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

  onMount(() => {
    const unsubscribe = store.store.subscribe(next => {
      const prevKeys = new Set(Object.keys(assetStatuses));
      records = [...next.records];
      const nextStatuses = { ...assetStatuses };
      let hasNew = false;
      for (const record of next.records) {
        if (!prevKeys.has(record.originalPath)) {
          hasNew = true;
          const isRecent = Date.now() - record.updatedAt < 300_000;
          nextStatuses[record.originalPath] = isRecent ? "present" : "unknown";
          nextStatuses[record.compressedPath] = isRecent ? "present" : "unknown";
        }
      }
      assetStatuses = nextStatuses;
      if (mounted && hasNew) {
        void verifyRecords(next.records.filter(r => !prevKeys.has(r.originalPath)));
      }
    });
    mounted = true;
    const handleTabActivate = () => { void refresh(); };
    window.addEventListener("omnikit-dock-tab-activated", handleTabActivate);
    void refresh();
    return () => {
      unsubscribe();
      window.removeEventListener("omnikit-dock-tab-activated", handleTabActivate);
    };
  });

  async function checkAsset(path: string): Promise<"present" | "missing" | "unknown"> {
    try {
      const res = await kernel.post<unknown>("/api/asset/statAsset", { path });
      return res.code === 0 ? "present" : "missing";
    } catch (error) {
      if (error instanceof KernelRequestError && error.code === 1) {
        return "missing";
      }
      return "unknown";
    }
  }

  async function verifyRecords(recordsToCheck: CompressionRecord[]): Promise<void> {
    for (let offset = 0; offset < recordsToCheck.length; offset += 3) {
      await Promise.all(recordsToCheck.slice(offset, offset + 3).map(async record => {
        try {
          const [origStatus, compStatus] = await Promise.all([
            checkAsset(record.originalPath),
            checkAsset(record.compressedPath),
          ]);
          assetStatuses[record.originalPath] = origStatus;
          assetStatuses[record.compressedPath] = compStatus;
          if (origStatus === "missing" || compStatus === "missing") {
            await store.removeRecord(record.originalPath);
          }
        } catch {
          assetStatuses[record.originalPath] = "unknown";
          assetStatuses[record.compressedPath] = "unknown";
        }
      }));
    }
  }

  async function refresh(): Promise<void> {
    loading = true;
    message = "";
    try {
      await ready;
      records = [...store.snapshot()];
      const snapshot = [...records];
      for (const record of snapshot) {
        assetStatuses[record.originalPath] = "checking";
        assetStatuses[record.compressedPath] = "checking";
      }
      let prunedCount = 0;
      for (let offset = 0; offset < snapshot.length; offset += 3) {
        await Promise.all(snapshot.slice(offset, offset + 3).map(async record => {
          try {
            const [origStatus, compStatus] = await Promise.all([
              checkAsset(record.originalPath),
              checkAsset(record.compressedPath),
            ]);
            assetStatuses[record.originalPath] = origStatus;
            assetStatuses[record.compressedPath] = compStatus;

            if (origStatus === "missing" || compStatus === "missing") {
              await store.removeRecord(record.originalPath);
              prunedCount++;
            }
          } catch {
            assetStatuses[record.originalPath] = "unknown";
            assetStatuses[record.compressedPath] = "unknown";
          }
        }));
      }
      if (prunedCount > 0) {
        records = [...store.snapshot()];
        message = format("image.records.prunedNotice", { count: prunedCount });
      }
    } catch {
      message = t("image.records.loadFailed");
    } finally {
      loading = false;
    }
  }

  async function findReferences(path: string): Promise<LocatedAssetReference[]> {
    const response = await kernel.post<unknown>("/api/asset/findAssetReferences", { paths: [path] }, { timeout: 120_000 });
    const data = response.data as { references?: unknown } | undefined;
    if (!data || !Array.isArray(data.references)) throw new Error("Reference response is incomplete");
    return data.references.map((row): LocatedAssetReference => {
      if (!row || typeof row !== "object") throw new Error("Invalid reference row");
      const item = row as Partial<LocatedAssetReference>;
      if (typeof item.type !== "string" || typeof item.rootID !== "string" ||
          typeof item.reference !== "string" || typeof item.relinkable !== "boolean" ||
          (item.notebook !== undefined && typeof item.notebook !== "string") ||
          (item.blockID !== undefined && typeof item.blockID !== "string")) {
        throw new Error("Invalid reference row");
      }
      return item as LocatedAssetReference;
    });
  }

  async function locateOccurrences(
    record: CompressionRecord,
    mode: "original" | "compressed",
    source: "user_click" | "post_action" = "user_click"
  ): Promise<void> {
    expanded = { path: record.originalPath, mode };
    occurrences = [];
    busy = true;
    if (source === "user_click") {
      message = "";
    }
    const searchPath = mode === "original" ? record.originalPath : record.compressedPath;
    try {
      const rows = await findReferences(searchPath);
      const targets: OccurrenceItem[] = [];
      const seen = new Set<string>();
      const docPathCache = new Map<string, string>();
      for (const row of rows) {
        if (!row.blockID || !row.rootID || !row.notebook || !row.relinkable) continue;
        const identityKey = `${row.notebook}/${row.blockID}`;
        if (seen.has(identityKey)) continue;
        seen.add(identityKey);
        const [infoResponse, domResponse] = await Promise.all([
          kernel.post<unknown>("/api/block/getBlockInfo", { id: row.blockID, notebook: row.notebook }),
          kernel.post<unknown>("/api/block/getBlockDOM", { id: row.blockID, notebook: row.notebook }),
        ]);
        const info = infoResponse.data as { rootID?: unknown; box?: unknown; rootTitle?: unknown } | undefined;
        const block = domResponse.data as { id?: unknown; dom?: unknown } | undefined;
        if (info?.rootID !== row.rootID || info.box !== row.notebook || block?.id !== row.blockID ||
            typeof block.dom !== "string" || !block.dom.trim()) continue;
        const template = document.createElement("template");
        template.innerHTML = block.dom;
        const roots = [...template.content.children].filter(node => node.getAttribute("data-node-id") === row.blockID);
        if (template.content.children.length !== 1 || roots.length !== 1 || roots[0].querySelector("[data-node-id]")) continue;
        const images = [...roots[0].querySelectorAll("img")];

        let docTitle = docPathCache.get(row.rootID);
        if (!docTitle) {
          if (typeof info.rootTitle === "string" && info.rootTitle.trim()) {
            docTitle = info.rootTitle.trim();
          } else {
            try {
              const hpathRes = await kernel.post<string>("/api/filetree/getHPathByID", { id: row.rootID });
              if (typeof hpathRes.data === "string" && hpathRes.data.trim()) {
                docTitle = hpathRes.data.trim();
              }
            } catch {}
          }
          docTitle = docTitle || row.rootID;
          docPathCache.set(row.rootID, docTitle);
        }

        for (let imageOrdinal = 0; imageOrdinal < images.length; imageOrdinal++) {
          const image = images[imageOrdinal];
          const attribute = image.hasAttribute("data-src") ? "data-src" : "src";
          const oldPath = image.getAttribute(attribute);
          if (oldPath !== searchPath) continue;
          const target: OccurrenceTarget = {
            rootID: row.rootID,
            notebook: row.notebook,
            blockID: row.blockID,
            imageOrdinal,
            oldPath,
            baselineBlockDOM: block.dom,
          };
          const key = `${target.notebook}/${target.blockID}/${target.imageOrdinal}`;
          if (targets.some(item => item.key === key)) continue;
          targets.push({
            key,
            target,
            label: `${docTitle} · ${row.blockID} · ${t("image.records.imagePosition")} ${imageOrdinal + 1}`,
          });
        }
      }
      occurrences = targets;
      if (source === "user_click") {
        if (!targets.length) {
          message = mode === "original"
            ? t("image.records.noOriginalReferences")
            : t("image.records.noCompressedReferences");
        }
      } else {
        if (!targets.length) {
          expanded = null;
          occurrences = [];
        }
      }
    } catch {
      message = t("image.records.lookupFailed");
    } finally {
      busy = false;
    }
  }

  async function toggleOriginalReferences(record: CompressionRecord): Promise<void> {
    if (expanded?.path === record.originalPath && expanded.mode === "original") {
      expanded = null;
      occurrences = [];
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
      message = "";
      return;
    }
    await locateOccurrences(record, "compressed", "user_click");
  }

  async function replaceOccurrence(record: CompressionRecord, item: OccurrenceItem): Promise<void> {
    busy = true;
    message = "";
    try {
      await kernel.post<unknown>("/api/asset/statAsset", { path: record.compressedPath });
      const current = store.snapshot().find(r => r.originalPath === record.originalPath && r.compressedPath === record.compressedPath);
      if (!current) throw new Error("Record changed");
      if (item.target.oldPath !== record.originalPath) {
        const msg = format("image.records.replaceResult", { replaced: 0, conflicts: 1 });
        message = msg;
        showMessage(msg, 3000);
        await locateOccurrences(record, "original", "post_action");
        return;
      }
      const res = await references.commitOccurrence(item.target, record.compressedPath, context.scope?.signal);
      const replaced = res === "replaced" ? 1 : 0;
      const conflicts = res === "replaced" ? 0 : 1;
      const msg = format("image.records.replaceResult", { replaced, conflicts });
      message = msg;
      showMessage(msg, 3000);
      await locateOccurrences(record, "original", "post_action");
    } catch {
      message = t("image.records.lookupFailed");
      showMessage(t("image.records.lookupFailed"), 3000, "error");
    } finally {
      busy = false;
    }
  }

  async function replaceAllOccurrences(record: CompressionRecord): Promise<void> {
    if (!occurrences.length) return;
    busy = true;
    message = "";
    try {
      await kernel.post<unknown>("/api/asset/statAsset", { path: record.compressedPath });
      const current = store.snapshot().find(r => r.originalPath === record.originalPath && r.compressedPath === record.compressedPath);
      if (!current) throw new Error("Record changed");
      let replaced = 0;
      let conflicts = 0;
      for (const item of occurrences) {
        if (item.target.oldPath !== record.originalPath) {
          conflicts++;
          continue;
        }
        const res = await references.commitOccurrence(item.target, record.compressedPath, context.scope?.signal);
        if (res === "replaced") replaced++;
        else conflicts++;
      }
      const msg = format("image.records.replaceResult", { replaced, conflicts });
      message = msg;
      showMessage(msg, 3000);
      await locateOccurrences(record, "original", "post_action");
    } catch {
      message = t("image.records.lookupFailed");
      showMessage(t("image.records.lookupFailed"), 3000, "error");
    } finally {
      busy = false;
    }
  }

  async function restoreOccurrence(record: CompressionRecord, item: OccurrenceItem): Promise<void> {
    busy = true;
    message = "";
    try {
      await kernel.post<unknown>("/api/asset/statAsset", { path: record.originalPath });
      const current = store.snapshot().find(r => r.originalPath === record.originalPath && r.compressedPath === record.compressedPath);
      if (!current) throw new Error("Record changed");
      if (item.target.oldPath !== record.compressedPath) {
        const msg = format("image.records.restoreResult", { restored: 0, conflicts: 1 });
        message = msg;
        showMessage(msg, 3000);
        await locateOccurrences(record, "compressed", "post_action");
        return;
      }
      const res = await references.commitOccurrence(item.target, record.originalPath, context.scope?.signal);
      const restored = res === "replaced" ? 1 : 0;
      const conflicts = res === "replaced" ? 0 : 1;
      const msg = format("image.records.restoreResult", { restored, conflicts });
      message = msg;
      showMessage(msg, 3000);
      await locateOccurrences(record, "compressed", "post_action");
    } catch {
      message = t("image.records.restoreFailed");
      showMessage(t("image.records.restoreFailed"), 3000, "error");
    } finally {
      busy = false;
    }
  }

  async function restoreAllOccurrences(record: CompressionRecord): Promise<void> {
    if (!occurrences.length) return;
    busy = true;
    message = "";
    try {
      await kernel.post<unknown>("/api/asset/statAsset", { path: record.originalPath });
      const current = store.snapshot().find(r => r.originalPath === record.originalPath && r.compressedPath === record.compressedPath);
      if (!current) throw new Error("Record changed");
      let restored = 0;
      let conflicts = 0;
      for (const item of occurrences) {
        if (item.target.oldPath !== record.compressedPath) {
          conflicts++;
          continue;
        }
        const res = await references.commitOccurrence(item.target, record.originalPath, context.scope?.signal);
        if (res === "replaced") restored++;
        else conflicts++;
      }
      const msg = format("image.records.restoreResult", { restored, conflicts });
      message = msg;
      showMessage(msg, 3000);
      await locateOccurrences(record, "compressed", "post_action");
    } catch {
      message = t("image.records.restoreFailed");
      showMessage(t("image.records.restoreFailed"), 3000, "error");
    } finally {
      busy = false;
    }
  }

  async function copyPath(path: string): Promise<void> {
    try {
      await navigator.clipboard.writeText(path);
      message = t("image.records.copied");
      showMessage(t("image.records.copied"), 2000);
    } catch {
      message = t("image.records.copyFailed");
      showMessage(t("image.records.copyFailed"), 3000, "error");
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
      onclick={refresh}
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
        <li class="image-records__card">
          <div class="image-records__card-preview">
            <img
              class="image-records__img"
              src={`/${record.compressedPath}`}
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
                class={`image-records__badge image-records__badge--${assetStatuses[record.originalPath] ?? "unknown"}`}
                title={t("image.records.originalStatus")}
              >
                {#if (assetStatuses[record.originalPath] ?? "unknown") === "checking"}
                  <span class="image-records__spinner image-records__spinner--small" aria-hidden="true"></span>
                {/if}
                {t(`image.records.assetStatus.${assetStatuses[record.originalPath] ?? "unknown"}`)}
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
                class={`image-records__badge image-records__badge--${assetStatuses[record.compressedPath] ?? "unknown"}`}
                title={t("image.records.compressedStatus")}
              >
                {#if (assetStatuses[record.compressedPath] ?? "unknown") === "checking"}
                  <span class="image-records__spinner image-records__spinner--small" aria-hidden="true"></span>
                {/if}
                {t(`image.records.assetStatus.${assetStatuses[record.compressedPath] ?? "unknown"}`)}
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
                disabled={busy || (assetStatuses[record.originalPath] ?? "unknown") !== "present"}
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

                {#if occurrences.length}
                  <div class="image-records__occurrences">
                    {#each occurrences as item (item.key)}
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
                          onclick={() => expanded?.mode === "original" ? replaceOccurrence(record, item) : restoreOccurrence(record, item)}
                        >
                          {expanded.mode === "original" ? t("image.records.replaceThis") : t("image.records.restoreThis")}
                        </button>
                      </div>
                    {/each}
                  </div>

                  <div class="image-records__batch-actions">
                    <button
                      type="button"
                      class="b3-button"
                      disabled={busy || !occurrences.length}
                      onclick={() => expanded?.mode === "original" ? replaceAllOccurrences(record) : restoreAllOccurrences(record)}
                    >
                      {expanded.mode === "original" ? t("image.records.replaceAll") : t("image.records.restoreAll")}
                    </button>
                  </div>
                {:else if !busy}
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
    box-shadow: 0 1px 3px rgba(0, 0, 0, 0.04);
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
  .image-records__occurrences {
    display: flex;
    flex-direction: column;
    gap: 4px;
    margin-top: 4px;
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