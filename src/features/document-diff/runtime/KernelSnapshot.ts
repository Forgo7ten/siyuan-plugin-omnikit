import type { KernelClient } from "../../../core/host/KernelClient.ts";
import { resolveProtyleRunner } from "../../../core/host/ProtyleAdapter.ts";
import { extractBlockDomUnits } from "../model/BlockDomExtractor.ts";
import type { ConflictReadGateway, DocumentLocation, SiblingEntry } from "../model/conflict.ts";
import type { SemanticUnit } from "../model/types.ts";

export interface DocumentSnapshot {
  id: string;
  title: string;
  titleEmpty?: boolean;
  notebook: string;
  hPath?: string;
  units: SemanticUnit[];
  parityByBlockID: Map<string, string>;
  rootBlockIndexByBlockID: Map<string, number>;
  rootBlockIDs: string[];
}

interface DocInfoPayload {
  id?: string;
  rootID?: string;
  name?: string;
  ial?: Record<string, string>;
}

interface AttributeViewResponse {
  av?: Record<string, any>;
}

const VALID_ID_RE = /^\d{14}-[a-zA-Z0-9]{7}$/;

function collectAttributeViewIDs(domHtml: string): string[] {
  if (!domHtml.includes("data-av-id")) return [];
  const ids = new Set<string>();
  const re = /\bdata-av-id=(?:"([^"]+)"|'([^']+)')/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(domHtml)) !== null) {
    const id = (match[1] ?? match[2] ?? "").trim();
    if (VALID_ID_RE.test(id)) {
      ids.add(id);
    }
  }
  return [...ids];
}

function stableSortJson(value: unknown, keyMap?: ReadonlyMap<string, string>): unknown {
  if (value === null || value === undefined) return null;
  if (typeof value === "string") {
    return keyMap?.get(value) ?? value;
  }
  if (typeof value !== "object") return value;
  if (Array.isArray(value)) {
    return value.map(item => stableSortJson(item, keyMap));
  }
  const obj = value as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const k of Object.keys(obj).sort()) {
    if (obj[k] !== undefined) {
      out[k] = stableSortJson(obj[k], keyMap);
    }
  }
  return out;
}

const VOLATILE_AV_VALUE_KEYS = new Set([
  "id",
  "keyID",
  "blockID",
  "createdAt",
  "updatedAt",
  "isDetached",
]);

/**
 * Produces an ID-neutral canonical content signature for a SiYuan AttributeView database
 * so both mirrored conflict databases and duplicated databases compare by columns, views, and cell values.
 */
export function canonicalizeAttributeViewData(rawAv: unknown): string | undefined {
  if (!rawAv || typeof rawAv !== "object" || Array.isArray(rawAv)) return undefined;
  const av = rawAv as Record<string, any>;
  if (!Array.isArray(av.keyValues) && !Array.isArray(av.views)) return undefined;
  const rawKeyValues = Array.isArray(av.keyValues) ? av.keyValues : [];
  const keyOrder: string[] = Array.isArray(av.keyIDs) ? av.keyIDs : [];
  const orderIndex = new Map<string, number>();
  keyOrder.forEach((kid, idx) => {
    if (typeof kid === "string") orderIndex.set(kid, idx);
  });

  const sortedKeyValues = [...rawKeyValues].sort((a, b) => {
    const idA = typeof a?.key?.id === "string" ? a.key.id : "";
    const idB = typeof b?.key?.id === "string" ? b.key.id : "";
    const idxA = orderIndex.get(idA) ?? Number.MAX_SAFE_INTEGER;
    const idxB = orderIndex.get(idB) ?? Number.MAX_SAFE_INTEGER;
    return idxA !== idxB ? idxA - idxB : idA.localeCompare(idB);
  });

  const keyIdMap = new Map<string, string>();
  sortedKeyValues.forEach((kv, idx) => {
    const kid = kv?.key?.id;
    if (typeof kid === "string" && kid) {
      keyIdMap.set(kid, `@col:${idx}`);
    }
  });

  const columns = sortedKeyValues.map(kv => {
    const rawKey = kv?.key && typeof kv.key === "object" ? kv.key : {};
    const options = Array.isArray(rawKey.options)
      ? rawKey.options.map((opt: any) => ({
          name: opt?.name ?? "",
          color: opt?.color ?? "",
          desc: opt?.desc ?? "",
        }))
      : [];
    const values = Array.isArray(kv?.values)
      ? kv.values.map((val: any) => {
          if (!val || typeof val !== "object") return null;
          const cleanVal: Record<string, unknown> = {};
          for (const k of Object.keys(val).sort()) {
            if (VOLATILE_AV_VALUE_KEYS.has(k)) continue;
            if (k === "block" && val.block && typeof val.block === "object") {
              cleanVal.block = { content: val.block.content ?? "" };
            } else {
              cleanVal[k] = stableSortJson(val[k], keyIdMap);
            }
          }
          return cleanVal;
        })
      : [];
    return {
      key: {
        name: rawKey.name ?? "",
        type: rawKey.type ?? "",
        icon: rawKey.icon ?? "",
        desc: rawKey.desc ?? "",
        numberFormat: rawKey.numberFormat ?? "",
        template: rawKey.template ?? "",
        options,
      },
      values,
    };
  });

  const views = Array.isArray(av.views)
    ? av.views.map((view: any) => ({
        name: view?.name ?? "",
        type: view?.type ?? "",
        icon: view?.icon ?? "",
        desc: view?.desc ?? "",
        hideAttrViewName: Boolean(view?.hideAttrViewName),
        hideAttrViewIcon: Boolean(view?.hideAttrViewIcon),
        pageSize: view?.pageSize ?? 0,
        filters: stableSortJson(view?.filters ?? [], keyIdMap),
        sorts: stableSortJson(view?.sorts ?? [], keyIdMap),
        group: stableSortJson(view?.group ?? null, keyIdMap),
      }))
    : [];

  return JSON.stringify({
    name: typeof av.name === "string" ? av.name : "",
    columns,
    views,
  });
}

export async function flushProtyleIfSupported(protyle: unknown, signal: AbortSignal): Promise<void> {
  if (signal.aborted || !protyle) return;
  const runner = resolveProtyleRunner(protyle);
  if (runner && typeof runner.flushPendingTransactions === "function") {
    try {
      await runner.flushPendingTransactions();
    } catch {
      // Non-fatal: `VisibleParity` catches any uncommitted local edit discrepancy.
    }
  }
}

/**
 * Read-only kernel gateway for document metadata, sibling enumeration, AttributeViews, and BlockDOM snapshots.
 */
export class KernelSnapshot implements ConflictReadGateway {
  constructor(
    private readonly kernel: KernelClient,
    private readonly signal: AbortSignal,
  ) {}

  async location(id: string): Promise<DocumentLocation> {
    const res = await this.kernel.post<DocumentLocation>(
      "/api/filetree/getPathByID",
      { id },
      { signal: this.signal },
    );
    if (!res.data?.notebook || !res.data?.path) {
      throw new Error("Unable to resolve document storage path");
    }
    return res.data;
  }

  private async docInfo(id: string, notebook?: string): Promise<{ name: string; titleEmpty: boolean }> {
    const payload: Record<string, unknown> = { id };
    if (notebook) payload.notebook = notebook;
    const res = await this.kernel.post<DocInfoPayload>(
      "/api/block/getDocInfo",
      payload,
      { signal: this.signal },
    );
    if (typeof res.data?.name !== "string") {
      throw new Error("Unable to read document title");
    }
    return {
      name: res.data.name,
      titleEmpty: res.data.ial?.["custom-sy-title-empty"] === "true",
    };
  }

  async title(id: string, notebook?: string): Promise<string> {
    return (await this.docInfo(id, notebook)).name;
  }

  async humanPath(id: string): Promise<string | undefined> {
    try {
      const res = await this.kernel.post<string>(
        "/api/filetree/getHPathByID",
        { id },
        { signal: this.signal },
      );
      return typeof res.data === "string" && res.data ? res.data : undefined;
    } catch {
      return undefined;
    }
  }

  async siblings(notebook: string, parentPath: string, maxCount: number): Promise<SiblingEntry[]> {
    const res = await this.kernel.post<{ files?: SiblingEntry[] }>(
      "/api/filetree/listDocsByPath",
      {
        notebook,
        path: parentPath,
        maxListCount: maxCount,
        ignoreMaxListHint: true,
        showHidden: true,
      },
      { signal: this.signal },
    );
    if (!Array.isArray(res.data?.files)) {
      throw new Error("Unable to list sibling documents");
    }
    return res.data.files;
  }

  private async readAttributeViewSignatures(domHtml: string): Promise<Map<string, string>> {
    const avIDs = collectAttributeViewIDs(domHtml);
    const out = new Map<string, string>();
    if (avIDs.length === 0) return out;

    await Promise.all(
      avIDs.map(async avID => {
        try {
          const res = await this.kernel.post<AttributeViewResponse>(
            "/api/av/getAttributeView",
            { id: avID },
            { signal: this.signal },
          );
          const rawAv =
            res.data && typeof res.data === "object" && "av" in res.data
              ? res.data.av
              : res.data;
          const sig = canonicalizeAttributeViewData(rawAv);
          if (sig !== undefined) {
            out.set(avID, sig);
          }
        } catch {
          // Leave absent in `out`: `BlockDomExtractor` will conservatively mark this AV block `unresolved`.
        }
      }),
    );
    return out;
  }

  async verifyDocumentReadable(id: string): Promise<{ id: string; title: string; notebook: string; hPath?: string }> {
    const loc = await this.location(id);
    const [info, hPath] = await Promise.all([
      this.docInfo(id, loc.notebook),
      this.humanPath(id),
    ]);
    return { id, title: info.name, notebook: loc.notebook, hPath };
  }

  async readSnapshot(id: string, notebook: string, protyle?: any): Promise<DocumentSnapshot> {
    if (protyle?.block?.rootID && protyle.block.rootID !== id) {
      throw new Error("Editor document changed during comparison");
    }
    await flushProtyleIfSupported(protyle, this.signal);
    if (this.signal.aborted) {
      throw new DOMException("Aborted", "AbortError");
    }

    const [info, domRes, hPath] = await Promise.all([
      this.docInfo(id, notebook),
      this.kernel.post<{ id?: string; dom?: string }>(
        "/api/block/getBlockDOM",
        { id, ...(notebook ? { notebook } : {}) },
        { signal: this.signal },
      ),
      this.humanPath(id),
    ]);

    if (typeof domRes.data?.dom !== "string") {
      throw new Error("Unable to read document BlockDOM");
    }

    const avSignatures = await this.readAttributeViewSignatures(domRes.data.dom);
    if (this.signal.aborted) {
      throw new DOMException("Aborted", "AbortError");
    }

    const extracted = extractBlockDomUnits(id, domRes.data.dom, { avSignatures });
    return {
      id,
      title: info.name,
      titleEmpty: info.titleEmpty,
      notebook,
      hPath,
      units: extracted.units,
      parityByBlockID: extracted.parityByBlockID,
      rootBlockIndexByBlockID: extracted.rootBlockIndexByBlockID,
      rootBlockIDs: extracted.rootBlockIDs,
    };
  }
}
