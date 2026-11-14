import type { KernelClient } from "../../core/KernelClient.ts";
import { resolveImageOccurrence, type ImageOccurrenceEvidence } from "./ImageOccurrenceResolver.ts";
import { commitOneImage, type CommitResult } from "./SafeBlockWriter.ts";
import { trySource } from "./source.ts";
import type { Mapping } from "./dom.ts";
import type { OccurrenceTarget } from "./contracts.ts";

const idPattern = /^\d{14}-[a-z0-9]{7}$/;
export interface DocumentRow { id: string; root_id: string; box: string }
export function sqlLiteral(value: string): string {
  if (value.includes("\0")) throw new Error("NUL is not allowed in SQL literals");
  return `'${value.replace(/'/g, "''")}'`;
}

/** Read-only keyset scan retained for callers that need an inventory; never used to broaden a write plan. */
export async function scanIndexedDocuments(k: KernelClient, max: number, signal?: AbortSignal): Promise<DocumentRow[]> {
  const rows: DocumentRow[] = []; let cursor = "";
  for (;;) {
    if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
    const stmt = `SELECT id, root_id, box FROM blocks WHERE type = 'd' AND id > ${sqlLiteral(cursor)} ORDER BY id ASC LIMIT 64`;
    const page = (await k.post<unknown>("/api/query/sql", { stmt, mode: "readonly" }, { signal })).data;
    if (!Array.isArray(page)) throw new Error("SQL did not return rows");
    if (!page.length) return rows;
    for (const row of page as any[]) {
      if (!row || typeof row.id !== "string" || !idPattern.test(row.id) || row.id <= cursor || row.root_id !== row.id || typeof row.box !== "string" || !idPattern.test(row.box)) throw new Error("Invalid or unordered SQL document row");
      cursor = row.id; rows.push(row);
      if (rows.length > max) throw new Error("Document scan limit exceeded; no references changed");
    }
  }
}

export async function blockDOM(k: KernelClient, id: string, notebook: string, signal?: AbortSignal): Promise<string> {
  const data = (await k.post<any>("/api/block/getBlockDOM", { id, notebook }, { signal })).data;
  if (!data || data.id !== id || typeof data.dom !== "string" || !data.dom.trim()) throw new Error("Invalid block DOM response");
  return data.dom;
}

export interface NativeReference { type: string; blockID: string; rootID: string; relinkable: boolean; reason: string }
export interface NativeItem { oldPath: string; newPath: string; ok: boolean; reason: string; updated: number; references: NativeReference[] }
export interface NativeData { items: NativeItem[]; references: NativeReference[]; skippedNotebooks: string[]; unavailableAttributeViews?: unknown[]; dryRun: boolean; historyPath: string; updated: number }
export interface BlockPatch {
  id: string; rootID: string; notebook: string; before: string; after: string;
  changes: 1; oldKeys: string[]; expectedOldCounts: Record<string, number>;
  expectedNewCounts: Record<string, number>;
  target: ImageOccurrenceEvidence & { baselineBlockDOM: string };
  newPath: string;
}
export type ReferencePlan = { backend: "sql" | "native"; mappings: Mapping[]; patches: BlockPatch[]; rootIDs: string[]; documents: DocumentRow[]; assetLocations: Record<string, string>; selectedOnly: boolean };
export interface ReferenceResult {
  backend: "sql" | "native";
  state: "verified" | "partial" | "unknown";
  referencesChanged: number | null;
  storageRecordsChanged: number | null;
  verifiedBlocks: string[];
  conflictBlocks: string[];
  cleanupEligible: boolean;
  reason?: string;
}

function parsed(dom: string): Document {
  const value = new DOMParser().parseFromString(dom, "text/html");
  if (value.querySelector("parsererror")) throw new Error("Unable to parse block DOM");
  return value;
}

function findOccurrences(dom: string, id: string, rootID: string, notebook: string, mappings: readonly Mapping[], origin: string, selectedBlockID?: string): BlockPatch[] {
  const document = parsed(dom);
  const blocks = [...document.querySelectorAll("[data-node-id]")].filter(block => block.getAttribute("data-node-id") === id);
  if (blocks.length !== 1 || blocks[0].querySelector("[data-node-id]")) return [];
  const block = blocks[0];
  const images = [...block.querySelectorAll("img")];
  const patches: BlockPatch[] = [];
  for (let imageOrdinal = 0; imageOrdinal < images.length; imageOrdinal++) {
    const image = images[imageOrdinal];
    if (image.closest("pre, code, script, style, [data-type='NodeCodeBlock'], [data-type='NodeBlockQueryEmbed']")) continue;
    const attribute = image.hasAttribute("data-src") ? "data-src" : "src";
    const oldPath = image.getAttribute(attribute);
    const source = oldPath && trySource(oldPath, origin);
    if (!source) continue;
    for (const mapping of mappings) {
      if (mapping.key !== source.key || selectedBlockID && id !== selectedBlockID) continue;
      if (mapping.selection) {
        if (mapping.selection.blockID !== id) continue;
        const matching = images.filter(candidate => {
          const raw = candidate.hasAttribute("data-src") ? candidate.getAttribute("data-src") : candidate.getAttribute("src");
          return raw && trySource(raw, origin)?.key === mapping.key;
        });
        const selectedIndex = matching.indexOf(image);
        if (matching.length !== mapping.selection.expectedCount || !mapping.selection.imageIndices.includes(selectedIndex)) continue;
      }
      const evidence = { rootID, notebook, blockID: id, imageOrdinal, oldPath };
      const target = resolveImageOccurrence(dom, evidence);
      if (!target) continue;
      const after = domPatch(dom, target, mapping.newPath);
      if (!after) continue;
      patches.push({ id, rootID, notebook, before: dom, after, changes: 1,
        oldKeys: [source.key], expectedOldCounts: {}, expectedNewCounts: {}, target, newPath: mapping.newPath });
      break;
    }
  }
  return patches;
}

function domPatch(dom: string, target: BlockPatch["target"], newPath: string): string | undefined {
  const document = parsed(dom);
  const roots = [...document.body.children].filter(node => node.getAttribute("data-node-id") === target.blockID);
  if (roots.length !== 1 || document.body.children.length !== 1 || roots[0].querySelector("[data-node-id]")) return undefined;
  const images = [...roots[0].querySelectorAll("img")];
  const image = images[target.imageOrdinal];
  if (!image) return undefined;
  const attribute = image.hasAttribute("data-src") ? "data-src" : "src";
  if (image.getAttribute(attribute) !== target.oldPath) return undefined;
  image.setAttribute(attribute, newPath);
  if (attribute === "data-src" && image.getAttribute("src") === target.oldPath) image.setAttribute("src", newPath);
  return roots[0].outerHTML;
}

/** Occurrence-scoped block updates only. SQL is restricted to readonly inventory queries. */
export class ReferenceService {
  constructor(private readonly k: KernelClient, private readonly origin: string) {}

  /** Direct single-position API for callers that already hold an authorized occurrence snapshot. */
  commitOccurrence(target: OccurrenceTarget, newPath: string, signal?: AbortSignal): Promise<CommitResult> {
    return commitOneImage(this.k, target, newPath, this.origin, signal);
  }

  async plan(mappings: Mapping[], seed: DocumentRow, _maxDocuments: number, _forceSQL = false, selectedBlockID?: string, signal?: AbortSignal): Promise<ReferencePlan> {
    if (!mappings.length || new Set(mappings.map(mapping => mapping.key)).size !== mappings.length) throw new Error("Empty or duplicate mappings");
    if (!seed.id || seed.root_id !== seed.id || !seed.box) throw new Error("Document identity unavailable");
    const rootDOM = await blockDOM(this.k, seed.id, seed.box, signal);
    const root = parsed(rootDOM);
    const blockIDs = new Set([...root.querySelectorAll("[data-node-id]")].map(node => node.getAttribute("data-node-id")).filter((value): value is string => Boolean(value)));
    if (selectedBlockID) blockIDs.clear(), blockIDs.add(selectedBlockID);
    const patches: BlockPatch[] = [];
    for (const id of blockIDs) {
      if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
      const dom = await blockDOM(this.k, id, seed.box, signal);
      patches.push(...findOccurrences(dom, id, seed.id, seed.box, mappings, this.origin, selectedBlockID));
    }
    if (!patches.length) throw new Error("No uniquely located image occurrences found; no references changed");
    return { backend: "sql", mappings, patches, rootIDs: [seed.id], documents: [seed], assetLocations: {}, selectedOnly: Boolean(selectedBlockID) };
  }

  async commit(plan: ReferencePlan, signal?: AbortSignal): Promise<ReferenceResult> {
    const verifiedBlocks = new Set<string>(), conflictBlocks = new Set<string>();
    let changed = 0;
    for (const patch of plan.patches) {
      if (signal?.aborted) return { backend: "sql", state: "partial", referencesChanged: changed, storageRecordsChanged: verifiedBlocks.size, verifiedBlocks: [...verifiedBlocks], conflictBlocks: [...conflictBlocks], cleanupEligible: false, reason: "Aborted after partial work" };
      const result: CommitResult = await commitOneImage(this.k, patch.target, patch.newPath, this.origin, signal);
      if (result === "replaced") { verifiedBlocks.add(patch.id); changed++; }
      else if (result === "conflict") conflictBlocks.add(patch.id);
      else return { backend: "sql", state: "unknown", referencesChanged: changed, storageRecordsChanged: verifiedBlocks.size, verifiedBlocks: [...verifiedBlocks], conflictBlocks: [...conflictBlocks], cleanupEligible: false, reason: "Block update outcome could not be verified; write was not retried" };
    }
    const state = conflictBlocks.size ? (changed ? "partial" : "partial") : "verified";
    return { backend: "sql", state, referencesChanged: changed, storageRecordsChanged: verifiedBlocks.size, verifiedBlocks: [...verifiedBlocks], conflictBlocks: [...conflictBlocks], cleanupEligible: false };
  }
}
