import { isAbortError } from "../../../core/feedback/UiFeedback.ts";
import { isInsideProtectedContainer } from "../../../core/host/dom.ts";
import type { KernelClient } from "../../../core/host/KernelClient.ts";
import { combineSignals } from "../../../core/host/ProtyleAdapter.ts";
import type { AssetAvailability, CompressionRecord, OccurrenceTarget } from "../policy/contracts.ts";
import { findLinkCandidates } from "../policy/dom.ts";
import { sameAsset, trySource } from "../policy/source.ts";
import type { ImageCompressionRecordStore } from "../store/ImageCompressionRecordStore.ts";
import { imagePath } from "./ImageOccurrenceResolver.ts";
import { resolveDocumentTitle } from "./documentTitle.ts";

const DOM_BATCH_SIZE = 50;

export interface LocatedAssetReference {
  type: string;
  rootID: string;
  notebook?: string;
  blockID?: string;
  reference: string;
  relinkable: boolean;
  reason?: string;
}

export interface OccurrenceItem {
  key: string;
  label: string;
  target: OccurrenceTarget;
}

export interface UnsupportedReferenceItem {
  key: string;
  label: string;
  rootID: string;
  blockID?: string;
}

export interface LocateReferencesResult {
  ok: boolean;
  complete: boolean;
  encryptedUnavailable: boolean;
  items: OccurrenceItem[];
  unsupported: UnsupportedReferenceItem[];
  skippedNotebooks: string[];
  unavailableAttributeViews: number;
  metadataIncomplete: boolean;
}

const GET_FILE_TIMEOUT_MS = 30_000;

function readKernelCode(raw: string): number | undefined {
  try {
    const parsed = JSON.parse(raw) as { code?: unknown } | null;
    return typeof parsed?.code === "number" ? parsed.code : undefined;
  } catch {
    return undefined;
  }
}

async function verifyOrdinaryAssetViaGetFile(
  kernelPath: string,
  signal?: AbortSignal,
  fetchFn?: typeof fetch,
): Promise<AssetAvailability> {
  const fetcher = fetchFn ?? globalThis.fetch;
  if (typeof fetcher !== "function") return "unknown";
  const timeoutController = new AbortController();
  const timer = setTimeout(() => timeoutController.abort(new Error("getFile timed out")), GET_FILE_TIMEOUT_MS);
  const effectiveSignal = combineSignals(signal, timeoutController.signal) ?? timeoutController.signal;
  try {
    const response = await fetcher("/api/file/getFile", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path: `data/${kernelPath}` }),
      signal: effectiveSignal,
    });
    if (response.status === 200) {
      await response.body?.cancel?.().catch(() => undefined);
      return "present";
    }
    if (response.status === 202) {
      const text = await response.text();
      return readKernelCode(text) === 404 ? "missing-confirmed" : "unknown";
    }
    await response.body?.cancel?.().catch(() => undefined);
    return "unknown";
  } catch (error) {
    if (signal?.aborted || isAbortError(error)) {
      if (signal?.aborted) throw error;
    }
    return "unknown";
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Checks asset availability via `/api/asset/statAsset` while preserving `?box=` parameters.
 * When an ordinary asset (without `?box=`) returns ambiguous `code === 1`, falls back to
 * `/api/file/getFile`: HTTP 200 confirms `"present"`, while HTTP 202 + `code: 404` confirms
 * `"missing-confirmed"`. Encrypted `?box=` assets and all other errors stay `"unknown"`.
 */
export async function checkAssetAvailability(
  kernel: KernelClient,
  path: string,
  signal?: AbortSignal,
  options?: { fetchFn?: typeof fetch; origin?: string },
): Promise<AssetAvailability> {
  let statCodeOne = false;
  try {
    const res = await kernel.post<unknown>("/api/asset/statAsset", { path }, { signal });
    if (res.code === 0) return "present";
    statCodeOne = res.code === 1;
  } catch (error) {
    if (signal?.aborted || isAbortError(error)) throw error;
    statCodeOne = (error as { code?: unknown })?.code === 1;
  }

  if (!statCodeOne) return "unknown";
  const parsed = trySource(path, options?.origin ?? "http://127.0.0.1:6806");
  if (!parsed || parsed.kind !== "asset" || parsed.box) {
    return "unknown";
  }
  return verifyOrdinaryAssetViaGetFile(parsed.kernelPath, signal, options?.fetchFn);
}

/**
 * Reconciles one record's original and latest compressed asset availability.
 * Removes ONLY that single record (via atomic `compareAndRemove`) when either asset
 * is proven `"missing-confirmed"`. Never deletes physical files or cascades across chains.
 */
export async function reconcileRecordPair(
  record: CompressionRecord,
  checkAsset: (path: string, signal?: AbortSignal) => Promise<AssetAvailability>,
  records: Pick<ImageCompressionRecordStore, "compareAndRemove">,
  signal?: AbortSignal,
): Promise<{ original: AssetAvailability; compressed: AssetAvailability; removed: boolean }> {
  const [original, compressed] = await Promise.all([
    checkAsset(record.originalPath, signal),
    checkAsset(record.compressedPath, signal),
  ]);
  if (signal?.aborted) return { original, compressed, removed: false };
  if (original === "missing-confirmed" || compressed === "missing-confirmed") {
    const removed = await records.compareAndRemove(record.originalPath, record.compressedPath);
    return { original, compressed, removed };
  }
  return { original, compressed, removed: false };
}

export async function findAssetReferences(
  kernel: KernelClient,
  path: string,
  signal?: AbortSignal,
): Promise<{
  references: LocatedAssetReference[];
  skippedNotebooks: string[];
  unavailableAttributeViews: number;
  metadataIncomplete: boolean;
}> {
  const response = await kernel.post<unknown>("/api/asset/findAssetReferences", { paths: [path] }, { timeout: 120_000, signal });
  const data = response.data as {
    references?: unknown;
    skippedNotebooks?: unknown;
    unavailableAttributeViews?: unknown;
  } | undefined;
  if (!data || !Array.isArray(data.references)) throw new Error("Reference response is incomplete");
  let rowFiltered = false;
  const references = data.references.filter((row): row is LocatedAssetReference => {
    if (!row || typeof row !== "object") { rowFiltered = true; return false; }
    const item = row as Partial<LocatedAssetReference>;
    const valid = typeof item.rootID === "string"
      && (item.relinkable === undefined || typeof item.relinkable === "boolean")
      && (item.notebook === undefined || typeof item.notebook === "string")
      && (item.blockID === undefined || typeof item.blockID === "string");
    if (!valid) rowFiltered = true;
    return valid;
  });
  const skippedValid = Array.isArray(data.skippedNotebooks);
  const skippedNotebooks = skippedValid
    ? (data.skippedNotebooks as unknown[]).filter((item): item is string => typeof item === "string" && item.length > 0)
    : [];
  const avValid = data.unavailableAttributeViews === undefined || Array.isArray(data.unavailableAttributeViews);
  const unavailableAttributeViews = Array.isArray(data.unavailableAttributeViews)
    ? data.unavailableAttributeViews.length
    : 0;
  return {
    references,
    skippedNotebooks,
    unavailableAttributeViews,
    metadataIncomplete: !skippedValid || !avValid || rowFiltered,
  };
}

export async function loadBatchBlockDOMs(
  kernel: KernelClient,
  notebook: string,
  blockIDs: string[],
  signal?: AbortSignal,
): Promise<{ doms: Map<string, string>; incomplete: boolean }> {
  const doms = new Map<string, string>();
  let incomplete = false;
  for (let offset = 0; offset < blockIDs.length; offset += DOM_BATCH_SIZE) {
    if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
    const chunk = blockIDs.slice(offset, offset + DOM_BATCH_SIZE);
    try {
      const res = await kernel.post<Record<string, unknown>>("/api/block/getBlockDOMs", { ids: chunk, notebook }, { signal });
      const data = res.data;
      if (!data || typeof data !== "object") {
        incomplete = true;
        continue;
      }
      for (const id of chunk) {
        const dom = data[id];
        if (typeof dom === "string" && dom.trim()) doms.set(id, dom);
        else incomplete = true;
      }
    } catch (error) {
      if (signal?.aborted || isAbortError(error)) throw error;
      for (const id of chunk) {
        if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
        try {
          const single = await kernel.post<{ id?: unknown; dom?: unknown }>("/api/block/getBlockDOM", { id, notebook }, { signal });
          if (single.data?.id === id && typeof single.data.dom === "string" && single.data.dom.trim()) {
            doms.set(id, single.data.dom);
          } else {
            incomplete = true;
          }
        } catch (singleErr) {
          if (signal?.aborted || isAbortError(singleErr)) throw singleErr;
          incomplete = true;
        }
      }
    }
  }
  return { doms, incomplete };
}

function matchesSearchAsset(raw: string | null | undefined, searchPath: string, origin: string): boolean {
  if (!raw) return false;
  return raw === searchPath || sameAsset(raw, searchPath, origin);
}

function extractBlockOccurrences(
  dom: string,
  meta: { rootID: string; notebook: string; blockID: string; docTitle: string },
  searchPath: string,
  origin: string,
  t: (key: string, values?: Record<string, string | number>) => string,
): { items: OccurrenceItem[]; nestedOrInvalid: boolean } {
  const template = document.createElement("template");
  template.innerHTML = dom;
  const roots = [...template.content.children].filter(node => node.getAttribute("data-node-id") === meta.blockID);
  if (template.content.children.length !== 1 || roots.length !== 1 || roots[0].querySelector("[data-node-id]")) {
    return { items: [], nestedOrInvalid: true };
  }
  const block = roots[0];
  const items: OccurrenceItem[] = [];

  const images = [...block.querySelectorAll("img")];
  for (let imageOrdinal = 0; imageOrdinal < images.length; imageOrdinal++) {
    const image = images[imageOrdinal];
    if (isInsideProtectedContainer(image)) continue;
    const oldPath = imagePath(image);
    if (!matchesSearchAsset(oldPath, searchPath, origin)) continue;
    const attribute: "data-src" | "src" = image.hasAttribute("data-src") ? "data-src" : "src";
    const target: OccurrenceTarget = {
      rootID: meta.rootID,
      notebook: meta.notebook,
      blockID: meta.blockID,
      kind: "image",
      attribute,
      imageOrdinal,
      oldPath: oldPath!,
      baselineBlockDOM: dom,
    };
    items.push({
      key: `image/${target.notebook}/${target.blockID}/${target.imageOrdinal}`,
      target,
      label: `${meta.docTitle} · ${meta.blockID} · ${t("image.records.imagePosition")} ${imageOrdinal + 1}`,
    });
  }

  const links = findLinkCandidates(block);
  for (let linkOrdinal = 0; linkOrdinal < links.length; linkOrdinal++) {
    const candidate = links[linkOrdinal];
    const oldPath = candidate.element.getAttribute(candidate.attribute);
    if (!matchesSearchAsset(oldPath, searchPath, origin)) continue;
    const textPreview = (candidate.element.textContent || "").trim();
    const linkSuffix = textPreview ? `${textPreview.slice(0, 32)} #${linkOrdinal + 1}` : `#${linkOrdinal + 1}`;
    const target: OccurrenceTarget = {
      rootID: meta.rootID,
      notebook: meta.notebook,
      blockID: meta.blockID,
      kind: "link",
      attribute: candidate.attribute,
      imageOrdinal: linkOrdinal,
      oldPath: oldPath!,
      baselineBlockDOM: dom,
    };
    items.push({
      key: `link/${target.notebook}/${target.blockID}/${target.imageOrdinal}`,
      target,
      label: `${meta.docTitle} · ${meta.blockID} · ${linkSuffix}`,
    });
  }

  return { items, nestedOrInvalid: false };
}

/**
 * Resolves references to a `?box=` encrypted-notebook asset exclusively via
 * authorized, unlocked notebook document/block read APIs without stripping `?box=`.
 */
async function locateBoxScopedOccurrences(
  kernel: KernelClient,
  boxID: string,
  searchPath: string,
  origin: string,
  t: (key: string, values?: Record<string, string | number>) => string,
  signal?: AbortSignal,
): Promise<LocateReferencesResult> {
  const lsRes = await kernel.post<{ notebooks?: Array<{ id?: string; closed?: boolean; name?: string }> }>(
    "/api/notebook/lsNotebooks",
    {},
    { signal },
  );
  const notebooks = lsRes.data?.notebooks;
  const targetNotebook = Array.isArray(notebooks)
    ? notebooks.find(nb => nb?.id === boxID)
    : undefined;
  if (!targetNotebook || targetNotebook.closed === true) {
    return {
      ok: false,
      complete: false,
      encryptedUnavailable: true,
      items: [],
      unsupported: [],
      skippedNotebooks: [boxID],
      unavailableAttributeViews: 0,
      metadataIncomplete: false,
    };
  }

  interface DocEntry { id: string; path: string; name: string }
  const docs: DocEntry[] = [];
  const queue: string[] = ["/"];
  const visitedPaths = new Set<string>();
  let complete = true;

  while (queue.length > 0) {
    if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
    const currentPath = queue.shift()!;
    if (visitedPaths.has(currentPath)) continue;
    visitedPaths.add(currentPath);

    let listData: { files?: Array<{ id?: string; path?: string; name?: string; subFileCount?: number }> } | undefined;
    try {
      const listRes = await kernel.post<{ files?: Array<{ id?: string; path?: string; name?: string; subFileCount?: number }> }>(
        "/api/filetree/listDocsByPath",
        { notebook: boxID, path: currentPath, ignoreMaxListHint: true, maxListCount: 10_000 },
        { signal },
      );
      listData = listRes.data;
    } catch (error) {
      if (signal?.aborted || isAbortError(error)) throw error;
      if (currentPath === "/") {
        return {
          ok: false,
          complete: false,
          encryptedUnavailable: true,
          items: [],
          unsupported: [],
          skippedNotebooks: [boxID],
          unavailableAttributeViews: 0,
          metadataIncomplete: false,
        };
      }
      complete = false;
      continue;
    }

    const files = Array.isArray(listData?.files) ? listData.files : [];
    for (const file of files) {
      if (!file?.id || !file?.path) continue;
      docs.push({ id: file.id, path: file.path, name: file.name || file.id });
      if ((file.subFileCount ?? 0) > 0) {
        queue.push(file.path);
      }
    }
  }

  const docDOMs = await loadBatchBlockDOMs(kernel, boxID, docs.map(d => d.id), signal);
  if (docDOMs.incomplete) complete = false;

  const matchedBlocks = new Map<string, { rootID: string; blockID: string }>();
  const unsupported: UnsupportedReferenceItem[] = [];
  const docTitleCache = new Map<string, string>();

  for (const doc of docs) {
    const dom = docDOMs.doms.get(doc.id);
    if (!dom) continue;
    const template = document.createElement("template");
    template.innerHTML = dom;

    const matchCandidate = (node: Element, raw: string | null | undefined) => {
      if (isInsideProtectedContainer(node)) return;
      if (!matchesSearchAsset(raw, searchPath, origin)) return;
      const owner = node.closest("[data-node-id]");
      const blockID = owner?.getAttribute("data-node-id");
      if (!blockID || owner?.querySelector("[data-node-id]")) {
        const key = `unsupported/${boxID}/${doc.id}/${blockID || "doc"}`;
        if (!unsupported.some(u => u.key === key)) {
          unsupported.push({
            key,
            rootID: doc.id,
            blockID: blockID || doc.id,
            label: `${doc.name || doc.id} · ${blockID || doc.id}`,
          });
        }
        return;
      }
      if (!matchedBlocks.has(blockID)) {
        matchedBlocks.set(blockID, { rootID: doc.id, blockID });
      }
    };

    for (const img of template.content.querySelectorAll("img")) {
      matchCandidate(img, imagePath(img));
    }
    for (const link of findLinkCandidates(template.content)) {
      matchCandidate(link.element, link.element.getAttribute(link.attribute));
    }
  }

  const blockDOMResult = matchedBlocks.size > 0
    ? await loadBatchBlockDOMs(kernel, boxID, [...matchedBlocks.keys()], signal)
    : { doms: new Map<string, string>(), incomplete: false };
  if (blockDOMResult.incomplete) complete = false;

  const items: OccurrenceItem[] = [];
  for (const [blockID, meta] of matchedBlocks) {
    const dom = blockDOMResult.doms.get(blockID);
    if (!dom) {
      complete = false;
      continue;
    }
    const docTitle = await resolveDocumentTitle(kernel, meta.rootID, { cache: docTitleCache, signal });
    const extracted = extractBlockOccurrences(dom, { ...meta, notebook: boxID, docTitle }, searchPath, origin, t);
    if (extracted.nestedOrInvalid) {
      complete = false;
      unsupported.push({
        key: `unsupported/${boxID}/${blockID}`,
        rootID: meta.rootID,
        blockID,
        label: `${docTitle} · ${blockID}`,
      });
      continue;
    }
    for (const item of extracted.items) {
      if (!items.some(existing => existing.key === item.key)) {
        items.push(item);
      }
    }
  }

  return {
    ok: true,
    complete,
    encryptedUnavailable: false,
    items,
    unsupported,
    skippedNotebooks: [],
    unavailableAttributeViews: 0,
    metadataIncomplete: false,
  };
}

/**
 * Locates both `<img>` and resource link references for an asset, grouping non-relinkable
 * or unmappable positions (e.g. attribute views) into `unsupported` for read-only navigation.
 */
export async function locateAssetOccurrences(
  kernel: KernelClient,
  origin: string,
  searchPath: string,
  t: (key: string, values?: Record<string, string | number>) => string,
  signal?: AbortSignal,
): Promise<LocateReferencesResult> {
  const parsed = trySource(searchPath, origin);
  if (!parsed || parsed.kind !== "asset") {
    throw new Error("Invalid asset path for reference lookup");
  }
  if (parsed.box) {
    return locateBoxScopedOccurrences(kernel, parsed.box, parsed.kernelPath, origin, t, signal);
  }

  const { references: rows, skippedNotebooks, unavailableAttributeViews, metadataIncomplete } =
    await findAssetReferences(kernel, parsed.kernelPath, signal);
  let complete = skippedNotebooks.length === 0 && unavailableAttributeViews === 0 && !metadataIncomplete;

  const distinctRows: Array<LocatedAssetReference & { blockID: string; notebook: string }> = [];
  const seen = new Set<string>();
  const idsByNotebook = new Map<string, string[]>();
  const unsupported: UnsupportedReferenceItem[] = [];
  const docTitleCache = new Map<string, string>();

  for (const row of rows) {
    if (!row.blockID || !row.rootID || !row.notebook || !row.relinkable) {
      complete = false;
      if (row.rootID) {
        const docTitle = await resolveDocumentTitle(kernel, row.rootID, { cache: docTitleCache, signal });
        const targetId = row.blockID || row.rootID;
        const suffix = row.reason || row.type || "readonly";
        const key = `unsupported/${row.notebook ?? ""}/${row.rootID}/${targetId}/${suffix}`;
        if (!unsupported.some(u => u.key === key)) {
          unsupported.push({
            key,
            rootID: row.rootID,
            blockID: row.blockID || row.rootID,
            label: `${docTitle} · ${suffix}`,
          });
        }
      }
      continue;
    }
    const identityKey = `${row.notebook}/${row.blockID}`;
    if (seen.has(identityKey)) continue;
    seen.add(identityKey);
    distinctRows.push(row as LocatedAssetReference & { blockID: string; notebook: string });
    const list = idsByNotebook.get(row.notebook) ?? [];
    list.push(row.blockID);
    idsByNotebook.set(row.notebook, list);
  }

  const domsByNotebook = new Map<string, Map<string, string>>();
  for (const [notebook, blockIDs] of idsByNotebook) {
    const batchResult = await loadBatchBlockDOMs(kernel, notebook, blockIDs, signal);
    if (batchResult.incomplete) complete = false;
    domsByNotebook.set(notebook, batchResult.doms);
  }

  const items: OccurrenceItem[] = [];
  for (const row of distinctRows) {
    const dom = domsByNotebook.get(row.notebook)?.get(row.blockID);
    if (!dom) { complete = false; continue; }
    const docTitle = await resolveDocumentTitle(kernel, row.rootID, { cache: docTitleCache, signal });
    const extracted = extractBlockOccurrences(
      dom,
      { rootID: row.rootID, notebook: row.notebook, blockID: row.blockID, docTitle },
      parsed.kernelPath,
      origin,
      t,
    );
    if (extracted.nestedOrInvalid) {
      complete = false;
      unsupported.push({
        key: `unsupported/${row.notebook}/${row.blockID}`,
        rootID: row.rootID,
        blockID: row.blockID,
        label: `${docTitle} · ${row.blockID}`,
      });
      continue;
    }
    for (const item of extracted.items) {
      if (!items.some(existing => existing.key === item.key)) {
        items.push(item);
      }
    }
  }

  return {
    ok: true,
    complete,
    encryptedUnavailable: false,
    items,
    unsupported,
    skippedNotebooks,
    unavailableAttributeViews,
    metadataIncomplete,
  };
}
