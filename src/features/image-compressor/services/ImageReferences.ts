import { isAbortError } from "../../../core/feedback/UiFeedback.ts";
import { isInsideProtectedContainer } from "../../../core/host/dom.ts";
import { Logger } from "../../../core/host/Logger.ts";
import type { KernelClient } from "../../../core/host/KernelClient.ts";
import type { OccurrenceTarget } from "../policy/contracts.ts";
import { findLinkCandidates, parseSingleLeafBlock } from "../policy/dom.ts";
import { imageSourceAttribute, sameSource, trySource } from "../policy/source.ts";
import { resolveDocumentTitle } from "./documentTitle.ts";
import { locateBoxScopedOccurrences } from "./boxReferenceLocator.ts";

export {
  checkAssetAvailability,
  reconcileRecordPair,
  verifyOrdinaryAssetViaGetFile,
} from "./assetAvailability.ts";
export { locateBoxScopedOccurrences } from "./boxReferenceLocator.ts";

const DOM_BATCH_SIZE = 50;

const NON_DOM_REWRITABLE_TYPES = new Set([
  "av-asset",
  "av-url",
  "html",
  "attribute",
  "title-image",
  "pdf-annotation",
]);

export interface LocatedAssetReference {
  type: string;
  rootID: string;
  notebook?: string;
  blockID?: string;
  avID?: string;
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

function isUnsupportedAssetReferenceRow(row: LocatedAssetReference): boolean {
  if (!row.blockID || !row.rootID || !row.notebook || !row.relinkable) return true;
  if (row.avID) return true;
  if (NON_DOM_REWRITABLE_TYPES.has(row.type)) return true;
  return false;
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
      && (item.blockID === undefined || typeof item.blockID === "string")
      && (item.avID === undefined || typeof item.avID === "string");
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
      Logger.shared.debug("批量读取块 DOM 失败，降级逐块读取", { notebook, count: chunk.length, error });
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

export function matchesSearchAsset(raw: string | null | undefined, searchPath: string, origin: string): boolean {
  if (!raw) return false;
  return raw === searchPath || sameSource(raw, searchPath, origin);
}

export function extractBlockOccurrences(
  dom: string,
  meta: { rootID: string; notebook: string; blockID: string; docTitle: string },
  searchPath: string,
  origin: string,
  t: (key: string, values?: Record<string, string | number>) => string,
): { items: OccurrenceItem[]; nestedOrInvalid: boolean } {
  const block = parseSingleLeafBlock(dom, meta.blockID);
  if (!block) {
    return { items: [], nestedOrInvalid: true };
  }
  const items: OccurrenceItem[] = [];

  const images = [...block.querySelectorAll("img")];
  for (let imageOrdinal = 0; imageOrdinal < images.length; imageOrdinal++) {
    const image = images[imageOrdinal];
    if (isInsideProtectedContainer(image)) continue;
    const oldPath = imageSourceAttribute(image);
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
    };
    items.push({
      key: `link/${target.notebook}/${target.blockID}/${target.imageOrdinal}`,
      target,
      label: `${meta.docTitle} · ${meta.blockID} · ${linkSuffix}`,
    });
  }

  return { items, nestedOrInvalid: false };
}

function escapeSqlLikeLiteral(value: string): string {
  return value
    .replace(/\\/g, "\\\\")
    .replace(/%/g, "\\%")
    .replace(/_/g, "\\_")
    .replace(/'/g, "''");
}

const CONTAINER_BLOCK_TYPES_SQL = "'d', 'b', 'l', 'i', 's', 'callout', 'tabs', 'tab', 'mindmap', 'mindmap_item'";

function buildRemoteSqlWhereClause(remoteUrl: string): string {
  const parsed = new URL(remoteUrl);
  const hostNeedle = escapeSqlLikeLiteral(parsed.hostname.toLowerCase());
  const rawPath = parsed.pathname;
  let decodedPath = rawPath;
  try {
    decodedPath = decodeURIComponent(rawPath);
  } catch {
    decodedPath = rawPath;
  }
  const pathNeedles = new Set<string>();
  if (rawPath && rawPath !== "/") pathNeedles.add(rawPath.toLowerCase());
  if (decodedPath && decodedPath !== "/") pathNeedles.add(decodedPath.toLowerCase());

  const conditions = [`LOWER(markdown) LIKE '%${hostNeedle}%' ESCAPE '\\'`];
  if (pathNeedles.size > 0) {
    const pathChecks = [...pathNeedles].map(
      needle => `LOWER(markdown) LIKE '%${escapeSqlLikeLiteral(needle)}%' ESCAPE '\\'`,
    );
    conditions.push(pathChecks.length === 1 ? pathChecks[0] : `(${pathChecks.join(" OR ")})`);
  }
  conditions.push(`type NOT IN (${CONTAINER_BLOCK_TYPES_SQL})`);
  return conditions.join(" AND ");
}

async function locateRemoteOccurrences(
  kernel: KernelClient,
  remoteUrl: string,
  origin: string,
  t: (key: string, values?: Record<string, string | number>) => string,
  signal?: AbortSignal,
): Promise<LocateReferencesResult> {
  const stmt = `SELECT id, root_id, box FROM blocks WHERE ${buildRemoteSqlWhereClause(remoteUrl)} LIMIT 200`;
  const res = await kernel.post<Array<{ id?: unknown; root_id?: unknown; box?: unknown } | null>>(
    "/api/query/sql",
    { stmt, mode: "readonly" },
    { signal },
  );
  if (!Array.isArray(res.data)) {
    throw new Error("Remote reference SQL response is incomplete");
  }
  let complete = res.data.length < 200 && res.truncated !== true;
  const distinctRows: Array<{ blockID: string; rootID: string; notebook: string }> = [];
  const seen = new Set<string>();
  const idsByNotebook = new Map<string, string[]>();

  for (const row of res.data) {
    if (!row || typeof row !== "object"
      || typeof row.id !== "string" || !row.id
      || typeof row.root_id !== "string" || !row.root_id
      || typeof row.box !== "string" || !row.box) {
      complete = false;
      continue;
    }
    const identityKey = `${row.box}/${row.id}`;
    if (seen.has(identityKey)) continue;
    seen.add(identityKey);
    distinctRows.push({ blockID: row.id, rootID: row.root_id, notebook: row.box });
    const list = idsByNotebook.get(row.box) ?? [];
    list.push(row.id);
    idsByNotebook.set(row.box, list);
  }

  const domsByNotebook = new Map<string, Map<string, string>>();
  for (const [notebook, blockIDs] of idsByNotebook) {
    const batchResult = await loadBatchBlockDOMs(kernel, notebook, blockIDs, signal);
    if (batchResult.incomplete) complete = false;
    domsByNotebook.set(notebook, batchResult.doms);
  }

  const items: OccurrenceItem[] = [];
  const unsupported: UnsupportedReferenceItem[] = [];
  const docTitleCache = new Map<string, string>();
  for (const row of distinctRows) {
    const dom = domsByNotebook.get(row.notebook)?.get(row.blockID);
    if (!dom) { complete = false; continue; }
    const docTitle = await resolveDocumentTitle(kernel, row.rootID, { cache: docTitleCache, signal });
    const extracted = extractBlockOccurrences(
      dom,
      { rootID: row.rootID, notebook: row.notebook, blockID: row.blockID, docTitle },
      remoteUrl,
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
    skippedNotebooks: [],
    unavailableAttributeViews: 0,
    metadataIncomplete: false,
  };
}

/**
 * Locates both `<img>` and resource link references for an asset or remote URL, grouping
 * non-relinkable or unmappable positions (e.g. attribute views, HTML blocks, title images)
 * into `unsupported` for read-only navigation.
 */
export async function locateAssetOccurrences(
  kernel: KernelClient,
  origin: string,
  searchPath: string,
  t: (key: string, values?: Record<string, string | number>) => string,
  signal?: AbortSignal,
  options?: { scopeBox?: string },
): Promise<LocateReferencesResult> {
  const parsed = trySource(searchPath, origin);
  if (!parsed) {
    throw new Error("Invalid asset path for reference lookup");
  }
  if (parsed.kind === "remote") {
    if (options?.scopeBox) {
      return locateBoxScopedOccurrences(kernel, options.scopeBox, parsed.url, origin, t, signal);
    }
    return locateRemoteOccurrences(kernel, parsed.url, origin, t, signal);
  }
  if (parsed.box) {
    return locateBoxScopedOccurrences(kernel, parsed.box, parsed.kernelPath, origin, t, signal);
  }

  const { references: rows, skippedNotebooks, unavailableAttributeViews, metadataIncomplete } =
    await findAssetReferences(kernel, parsed.kernelPath, signal);
  let effectiveUnavailableAVs = unavailableAttributeViews;
  let complete = skippedNotebooks.length === 0 && effectiveUnavailableAVs === 0 && !metadataIncomplete;

  const distinctRows: Array<LocatedAssetReference & { blockID: string; notebook: string }> = [];
  const seen = new Set<string>();
  const idsByNotebook = new Map<string, string[]>();
  const unsupported: UnsupportedReferenceItem[] = [];
  const docTitleCache = new Map<string, string>();

  for (const row of rows) {
    if (isUnsupportedAssetReferenceRow(row)) {
      complete = false;
      if (row.rootID) {
        const docTitle = await resolveDocumentTitle(kernel, row.rootID, { cache: docTitleCache, signal });
        const targetId = row.blockID || row.rootID;
        const suffix = row.reason || row.type || (row.avID ? "attribute-view" : "readonly");
        const key = `unsupported/${row.notebook ?? ""}/${row.rootID}/${targetId}/${row.avID ?? ""}/${suffix}`;
        if (!unsupported.some(u => u.key === key)) {
          unsupported.push({
            key,
            rootID: row.rootID,
            blockID: row.blockID || row.rootID,
            label: `${docTitle} · ${suffix}`,
          });
        }
      } else {
        effectiveUnavailableAVs += 1;
      }
      continue;
    }
    const identityKey = `${row.notebook}/${row.blockID}`;
    if (seen.has(identityKey)) continue;
    seen.add(identityKey);
    distinctRows.push(row as LocatedAssetReference & { blockID: string; notebook: string });
    const list = idsByNotebook.get(row.notebook!) ?? [];
    list.push(row.blockID!);
    idsByNotebook.set(row.notebook!, list);
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
    if (extracted.nestedOrInvalid || extracted.items.length === 0) {
      complete = false;
      const key = `unsupported/${row.notebook}/${row.blockID}`;
      if (!unsupported.some(u => u.key === key)) {
        unsupported.push({
          key,
          rootID: row.rootID,
          blockID: row.blockID,
          label: `${docTitle} · ${row.blockID}`,
        });
      }
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
    unavailableAttributeViews: effectiveUnavailableAVs,
    metadataIncomplete,
  };
}
