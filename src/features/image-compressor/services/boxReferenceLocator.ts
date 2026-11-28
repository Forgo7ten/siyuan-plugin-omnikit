import { isAbortError } from "../../../core/feedback/UiFeedback.ts";
import { isInsideProtectedContainer } from "../../../core/host/dom.ts";
import type { KernelClient } from "../../../core/host/KernelClient.ts";
import { findLinkCandidates } from "../policy/dom.ts";
import { imageSourceAttribute } from "../policy/source.ts";
import { resolveDocumentTitle } from "./documentTitle.ts";
import {
  extractBlockOccurrences,
  loadBatchBlockDOMs,
  matchesSearchAsset,
  type LocateReferencesResult,
  type OccurrenceItem,
  type UnsupportedReferenceItem,
} from "./ImageReferences.ts";

interface NotebookEntry {
  id?: string;
  closed?: boolean;
  name?: string;
  encrypted?: boolean;
  unlocked?: boolean;
  boxDocEnabled?: boolean;
}

/**
 * Resolves references to a `?box=` encrypted-notebook asset exclusively via
 * authorized, unlocked notebook document/block read APIs without stripping `?box=`.
 */
export async function locateBoxScopedOccurrences(
  kernel: KernelClient,
  boxID: string,
  searchPath: string,
  origin: string,
  t: (key: string, values?: Record<string, string | number>) => string,
  signal?: AbortSignal,
): Promise<LocateReferencesResult> {
  const lsRes = await kernel.post<{ notebooks?: NotebookEntry[]; boxDocEnabled?: boolean }>(
    "/api/notebook/lsNotebooks",
    {},
    { signal },
  );
  const notebooks = lsRes.data?.notebooks;
  const targetNotebook = Array.isArray(notebooks)
    ? notebooks.find(nb => nb?.id === boxID)
    : undefined;
  if (
    !targetNotebook ||
    targetNotebook.closed === true ||
    (targetNotebook.encrypted === true && targetNotebook.unlocked !== true)
  ) {
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
        {
          notebook: boxID,
          path: currentPath,
          showHidden: true,
          ignoreMaxListHint: true,
          maxListCount: 10_000,
        },
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

  const boxDocEnabled = targetNotebook.boxDocEnabled === true || lsRes.data?.boxDocEnabled === true;
  if (boxDocEnabled && !docs.some(d => d.id === boxID)) {
    try {
      const infoRes = await kernel.post<{ id?: string; rootID?: string; rootTitle?: string }>(
        "/api/block/getBlockInfo",
        { id: boxID, notebook: boxID },
        { signal },
      );
      const data = infoRes.data;
      if (data && (data.id === undefined || data.id === boxID) && data.rootID === boxID) {
        docs.unshift({
          id: boxID,
          path: `/${boxID}.sy`,
          name: data.rootTitle || targetNotebook.name || boxID,
        });
      }
    } catch (error) {
      if (signal?.aborted || isAbortError(error)) throw error;
      const code = (error as { code?: unknown })?.code;
      const outcome = (error as { outcome?: unknown })?.outcome;
      if (code === 3 || outcome === "unknown") {
        complete = false;
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
      matchCandidate(img, imageSourceAttribute(img));
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
