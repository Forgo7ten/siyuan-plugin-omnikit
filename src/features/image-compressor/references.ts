import type { KernelClient } from "../../core/KernelClient.ts";
import { ordinaryAssetLocations } from "./asset-identity.ts";
import { buildBlockPatch, patchWasApplied, scanDOM, type BlockPatch, type Mapping } from "./dom.ts";

const idPattern = /^\d{14}-[a-z0-9]{7}$/;
export interface DocumentRow { id: string; root_id: string; box: string }
export function sqlLiteral(value: string): string { if (value.includes("\0")) throw new Error("NUL is not allowed in SQL literals"); return `'${value.replace(/'/g, "''")}'`; }

export async function scanIndexedDocuments(k: KernelClient, max: number, signal?: AbortSignal): Promise<DocumentRow[]> {
  const rows: DocumentRow[] = []; let cursor = "";
  for (;;) {
    if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
    const stmt = `SELECT id, root_id, box FROM blocks WHERE type = 'd' AND id > ${sqlLiteral(cursor)} ORDER BY id ASC LIMIT 64`;
    const page = (await k.post<unknown>("/api/query/sql", { stmt, mode: "readonly" }, { signal })).data;
    if (!Array.isArray(page)) throw new Error("SQL did not return rows"); if (!page.length) return rows;
    for (const row of page as any[]) {
      if (!row || typeof row.id !== "string" || !idPattern.test(row.id) || row.id <= cursor || row.root_id !== row.id || typeof row.box !== "string" || !idPattern.test(row.box)) throw new Error("Invalid or unordered SQL document row");
      cursor = row.id; rows.push(row); if (rows.length > max) throw new Error("Document scan limit exceeded; no references changed");
    }
  }
}

export async function blockDOM(k: KernelClient, id: string, notebook: string, signal?: AbortSignal): Promise<string> {
  const data = (await k.post<any>("/api/block/getBlockDOM", { id, notebook }, { signal })).data;
  if (!data || data.id !== undefined && data.id !== id || typeof data.dom !== "string" || !data.dom.trim()) throw new Error("Invalid block DOM response");
  return data.dom;
}

export interface NativeReference { type: string; blockID: string; rootID: string; relinkable: boolean; reason: string }
export interface NativeItem { oldPath: string; newPath: string; ok: boolean; reason: string; updated: number; references: NativeReference[] }
export interface NativeData { items: NativeItem[]; references: NativeReference[]; skippedNotebooks: string[]; unavailableAttributeViews?: unknown[]; dryRun: boolean; historyPath: string; updated: number }
export type ReferencePlan =
  | { backend: "native"; mappings: Mapping[]; preview: NativeData; rootIDs: string[] }
  | { backend: "sql"; mappings: Mapping[]; patches: BlockPatch[]; rootIDs: string[]; documents: DocumentRow[]; assetLocations: Record<string, string>; selectedOnly: boolean };

export interface ReferenceResult {
  backend: "native" | "sql";
  state: "verified" | "partial" | "unknown";
  referencesChanged: number | null;
  storageRecordsChanged: number | null;
  verifiedBlocks: string[];
  conflictBlocks: string[];
  cleanupEligible: boolean;
  reason?: string;
}

function missingEndpoint(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const code = (error as Error & { code?: number }).code;
  return code === -404 || code === -405
    || /(?:HTTP|status|code|response)[ :]*(404|405)\b/i.test(error.message);
}

export function parseNative(raw: unknown): NativeData {
  const data = raw as NativeData;
  if (!data || !Array.isArray(data.items) || !Array.isArray(data.references) ||
    !Array.isArray(data.skippedNotebooks) || typeof data.dryRun !== "boolean" ||
    typeof data.historyPath !== "string" || !Number.isSafeInteger(data.updated) ||
    (data.unavailableAttributeViews !== undefined && !Array.isArray(data.unavailableAttributeViews))) {
    throw new Error("Unsupported native response schema");
  }
  if (data.items.some(item => !item || typeof item.oldPath !== "string" ||
    typeof item.newPath !== "string" || typeof item.ok !== "boolean" ||
    typeof item.reason !== "string" || !Number.isSafeInteger(item.updated) ||
    !Array.isArray(item.references))) throw new Error("Invalid native mapping result");
  return data;
}

export function nativeCovered(data: NativeData): boolean {
  return data.items.every(item => item.ok && !item.reason && item.references.every(ref => ref.relinkable)) &&
    data.references.every(ref => ref.relinkable) && !data.skippedNotebooks.length &&
    !data.unavailableAttributeViews?.length;
}

function matchNative(data: NativeData, mappings: readonly Mapping[], dryRun: boolean, lookup = false): void {
  if (data.dryRun !== dryRun || data.items.length !== mappings.length) throw new Error("Native result mismatch");
  const items = new Map(data.items.map(item => [item.oldPath, item]));
  if (items.size !== mappings.length || mappings.some(mapping => items.get(mapping.oldPath)?.newPath !== (lookup ? "" : mapping.newPath))) {
    throw new Error("Native mapping mismatch");
  }
}

/**
 * Common interface for reference rewriting backends (Native vs SQL fallback).
 */
export interface ReferenceDriver {
  readonly backend: "native" | "sql";
  canHandle(mappings: Mapping[], forceSQL: boolean, selectedBlockID?: string): boolean;
  plan(mappings: Mapping[], seed: DocumentRow, maxDocuments: number, selectedBlockID?: string, signal?: AbortSignal): Promise<ReferencePlan>;
  commit(plan: ReferencePlan, signal?: AbortSignal): Promise<ReferenceResult>;
}

/**
 * Native driver: uses SiYuan official /api/asset/findAssetReferences and /api/asset/relinkAsset.
 */
export class NativeReferenceDriver implements ReferenceDriver {
  readonly backend = "native";

  constructor(private readonly k: KernelClient) {}

  canHandle(mappings: Mapping[], forceSQL: boolean, selectedBlockID?: string): boolean {
    return !forceSQL && !selectedBlockID && mappings.every(m => m.oldPath.startsWith("assets/") && !m.key.includes("?box="));
  }

  async plan(mappings: Mapping[], _seed: DocumentRow, _maxDocuments: number, _selectedBlockID?: string, signal?: AbortSignal): Promise<ReferencePlan> {
    const lookup = parseNative((await this.k.post<unknown>("/api/asset/findAssetReferences", { paths: mappings.map(m => m.oldPath) }, { signal, timeout: 120000 })).data);
    matchNative(lookup, mappings, true, true);
    const preview = parseNative((await this.k.post<any>("/api/asset/relinkAsset", { mappings: mappings.map(({ oldPath, newPath }) => ({ oldPath, newPath })), dryRun: true }, { signal, timeout: 120000 })).data);
    matchNative(preview, mappings, true);
    if (!nativeCovered(preview)) throw new Error("Native preflight is incomplete");
    return {
      backend: "native",
      mappings,
      preview,
      rootIDs: [...new Set<string>(preview.references.map((r: any) => r.rootID).filter((x: any): x is string => typeof x === "string" && !!x))],
    };
  }

  async commit(plan: ReferencePlan, signal?: AbortSignal): Promise<ReferenceResult> {
    if (plan.backend !== "native") throw new Error("Driver mismatch");
    try {
      const data = parseNative((await this.k.post<any>("/api/asset/relinkAsset", { mappings: plan.mappings.map(({ oldPath, newPath }) => ({ oldPath, newPath })), dryRun: false }, { signal, timeout: 120000 })).data);
      matchNative(data, plan.mappings, false);
      if (!nativeCovered(data)) return { backend: "native", state: "partial", referencesChanged: null, storageRecordsChanged: data.updated, verifiedBlocks: [], conflictBlocks: [], cleanupEligible: false, reason: "Native write returned incomplete results" };
      const after = parseNative((await this.k.post<unknown>("/api/asset/findAssetReferences", { paths: plan.mappings.map(mapping => mapping.oldPath) }, { signal, timeout: 120000 })).data);
      matchNative(after, plan.mappings, true, true);
      const verified = nativeCovered(after) && !after.references.length && after.items.every(item => !item.references.length);
      return { backend: "native", state: verified ? "verified" : "partial", referencesChanged: null, storageRecordsChanged: data.updated, verifiedBlocks: [], conflictBlocks: [], cleanupEligible: verified, reason: verified ? undefined : "Old references remain" };
    } catch (error) {
      return { backend: "native", state: "unknown", referencesChanged: null, storageRecordsChanged: null, verifiedBlocks: [], conflictBlocks: [], cleanupEligible: false, reason: String(error) };
    }
  }
}

/**
 * SQL fallback driver: scans indexed document blocks, constructs DOM patches and writes via updateBlock.
 */
export class SqlReferenceDriver implements ReferenceDriver {
  readonly backend = "sql";

  constructor(private readonly k: KernelClient, private readonly origin: string) {}

  canHandle(): boolean {
    return true; // SQL can handle any reachable references as fallback
  }

  async plan(mappings: Mapping[], seed: DocumentRow, maxDocuments: number, selectedBlockID?: string, signal?: AbortSignal): Promise<ReferencePlan> {
    const paths = mappings.flatMap(m => [m.oldPath, m.newPath]).filter(p => p.startsWith("assets/"));
    const assetLocations = await ordinaryAssetLocations(this.k, paths, signal);
    const documents = selectedBlockID ? [seed] : await scanIndexedDocuments(this.k, maxDocuments, signal);
    const patches: BlockPatch[] = [], keys = new Set(mappings.map(m => m.key));
    for (const doc of documents) {
      const dom = await blockDOM(this.k, doc.id, doc.box, signal);
      const owners = new Set(scanDOM(dom, this.origin).filter(r => keys.has(r.key) && (!selectedBlockID || r.blockID === selectedBlockID)).map(r => r.blockID));
      for (const id of owners) {
        const patch = buildBlockPatch(await blockDOM(this.k, id, doc.box, signal), id, doc.id, doc.box, mappings, this.origin);
        if (patch) patches.push(patch);
      }
    }
    if (!patches.length) throw new Error("No persisted target references found");
    return { backend: "sql", mappings, patches, rootIDs: [...new Set(patches.map(p => p.rootID))], documents, assetLocations, selectedOnly: Boolean(selectedBlockID) };
  }

  async commit(plan: ReferencePlan, signal?: AbortSignal): Promise<ReferenceResult> {
    if (plan.backend !== "sql") throw new Error("Driver mismatch");
    const now = await ordinaryAssetLocations(this.k, Object.keys(plan.assetLocations), signal);
    if (Object.entries(plan.assetLocations).some(([p, v]) => now[p] !== v)) throw new Error("Physical asset locations changed after preview");
    const verifiedBlocks: string[] = [], conflictBlocks: string[] = []; let changed = 0;
    for (const p of plan.patches) {
      if (signal?.aborted) return { backend: "sql", state: "partial", referencesChanged: changed, storageRecordsChanged: verifiedBlocks.length, verifiedBlocks, conflictBlocks, cleanupEligible: false, reason: "Cancelled after partial work" };
      if (await blockDOM(this.k, p.id, p.notebook, signal) !== p.before) { conflictBlocks.push(p.id); continue; }
      try {
        await this.k.post("/api/block/updateBlock", { id: p.id, dataType: "dom", data: p.after, lockType: true }, { signal });
        if (!patchWasApplied(await blockDOM(this.k, p.id, p.notebook, signal), p, this.origin)) throw new Error("Block write verification failed");
        verifiedBlocks.push(p.id); changed += p.changes;
      } catch (error) {
        return { backend: "sql", state: "unknown", referencesChanged: changed, storageRecordsChanged: verifiedBlocks.length, verifiedBlocks, conflictBlocks, cleanupEligible: false, reason: String(error) };
      }
    }
    if (plan.selectedOnly) return { backend: "sql", state: conflictBlocks.length ? "partial" : "verified", referencesChanged: changed, storageRecordsChanged: verifiedBlocks.length, verifiedBlocks, conflictBlocks, cleanupEligible: false };
    const afterDocuments = await scanIndexedDocuments(this.k, Math.max(plan.documents.length + 1, 100000), signal);
    const keys = new Set(plan.mappings.map(mapping => mapping.key));
    let remaining = false;
    for (const doc of afterDocuments) {
      if (scanDOM(await blockDOM(this.k, doc.id, doc.box, signal), this.origin).some(ref => keys.has(ref.key))) remaining = true;
    }
    const inventoryStable = afterDocuments.map(doc => doc.id).join() === plan.documents.map(doc => doc.id).join();
    return { backend: "sql", state: !remaining && !conflictBlocks.length && inventoryStable ? "verified" : "partial", referencesChanged: changed, storageRecordsChanged: verifiedBlocks.length, verifiedBlocks, conflictBlocks, cleanupEligible: false };
  }
}

/**
 * Coordinates ReferenceDrivers with in-process concurrency write leases.
 */
export class ReferenceService {
  private tail: Promise<void> = Promise.resolve();
  private readonly nativeDriver: NativeReferenceDriver;
  private readonly sqlDriver: SqlReferenceDriver;

  constructor(private readonly k: KernelClient, private readonly origin: string) {
    this.nativeDriver = new NativeReferenceDriver(k);
    this.sqlDriver = new SqlReferenceDriver(k, origin);
  }

  withWriteLease<T>(signal: AbortSignal | undefined, operation: () => Promise<T>): Promise<T> {
    const result = this.tail.then(() => {
      if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
      return operation();
    });
    this.tail = result.then(() => undefined, () => undefined);
    return result;
  }

  async plan(mappings: Mapping[], seed: DocumentRow, maxDocuments: number, forceSQL = false, selectedBlockID?: string, signal?: AbortSignal): Promise<ReferencePlan> {
    if (!mappings.length || new Set(mappings.map(m => m.key)).size !== mappings.length) throw new Error("Empty or duplicate mappings");
    if (this.nativeDriver.canHandle(mappings, forceSQL, selectedBlockID)) {
      try {
        return await this.nativeDriver.plan(mappings, seed, maxDocuments, selectedBlockID, signal);
      } catch (error) {
        if (!missingEndpoint(error)) throw error;
      }
    }
    return this.sqlDriver.plan(mappings, seed, maxDocuments, selectedBlockID, signal);
  }

  async commit(plan: ReferencePlan, signal?: AbortSignal): Promise<ReferenceResult> {
    return this.withWriteLease(signal, async () => {
      if (plan.backend === "native") {
        return this.nativeDriver.commit(plan, signal);
      }
      return this.sqlDriver.commit(plan, signal);
    });
  }
}
