import { fetchPost } from "siyuan";
import { isDocumentRootIdentity, isSafeBlockId, type BlockIdentity } from "./DocumentIdentity.ts";

export interface KernelResponse<T> { code: number; data: T; msg: string; }
function post<T>(path: string, body: any, signal?: AbortSignal): Promise<KernelResponse<T>> {
  if (signal?.aborted) return Promise.reject(new DOMException("Operation cancelled", "AbortError"));
  return new Promise((resolve, reject) => fetchPost(path, body, response => {
    if (signal?.aborted) { reject(new DOMException("Operation cancelled", "AbortError")); return; }
    const result = response as unknown as KernelResponse<T>;
    if (result?.code !== 0) reject(new Error(result?.msg || `SiYuan API failed: ${path}`));
    else resolve(result);
  }));
}

/** @safety Upload creates a new resource; this repository never overwrites or removes originals. */
export class AssetRepository {
  async upload(blob: Blob, rootId: string, originalPath: string, signal?: AbortSignal): Promise<string> {
    if (signal?.aborted) throw new DOMException("Operation cancelled", "AbortError");
    const extension = originalPath.split(/[?#]/)[0].split(".").pop() || "image";
    const name = `${Date.now()}-${crypto.randomUUID()}.webp`;
    const form = new FormData(); form.append("file[]", blob, name); form.append("id", rootId);
    const response = await post<{ succFiles?: Array<{ path: string }>; failedFiles?: unknown[]; errFiles?: string[] }>("/api/asset/upload", form, signal);
    if (signal?.aborted) throw new DOMException("Operation cancelled", "AbortError");
    const assetPath = response.data?.succFiles?.[0]?.path;
    if (!assetPath || response.data?.failedFiles?.length || response.data?.errFiles?.length) throw new Error(`Asset upload failed (source type ${extension})`);
    return assetPath;
  }

  async getBlockDOM(id: string): Promise<string> {
    const response = await post<{ dom: string }>("/api/block/getBlockDOM", { id });
    if (!response.data?.dom) throw new Error("SiYuan returned an empty block DOM");
    return response.data.dom;
  }

  /** @compat Read-only identity lookup used before any allowlist write; has no type/box. */
  async getBlockInfo(id: string): Promise<BlockIdentity | undefined> {
    const response = await post<BlockIdentity>("/api/block/getBlockInfo", { id });
    return response.data;
  }

  /** @compat Block type and notebook id live in the local index, not in `BlockInfo`. */
  async queryBlockIdentity(id: string): Promise<BlockIdentity | undefined> {
    if (!isSafeBlockId(id)) return undefined;
    const response = await post<BlockIdentity[]>("/api/query/sql", {
      stmt: `select id, type, box, root_id as rootID from blocks where id = '${id}'`,
    });
    const row = Array.isArray(response.data) ? response.data[0] : undefined;
    return row ? { id: row.id, type: row.type, rootID: row.rootID, box: row.box } : undefined;
  }

  /**
   * @invariant The SQL index is authoritative; the metadata endpoint is a fallback for
   * kernels where querying is unavailable. Both are read-only.
   */
  async getBlockIdentity(id: string): Promise<BlockIdentity | undefined> {
    try {
      const indexed = await this.queryBlockIdentity(id);
      if (indexed) return indexed;
    } catch { /* fall through to the metadata endpoint */ }
    try { return await this.getBlockInfo(id); }
    catch { return undefined; }
  }

  /**
   * @safety A document root is the only valid allowlist target. A DOM attribute alone is
   * never trusted; the kernel must confirm that the id identifies a document block.
   */
  async isDocumentRoot(id: string): Promise<boolean> {
    return isDocumentRootIdentity(await this.getBlockIdentity(id), id);
  }

  async updateBlockDOM(id: string, dom: string, signal?: AbortSignal): Promise<void> {
    await post("/api/block/updateBlock", { id, data: dom, dataType: "dom", lockType: true }, signal);
  }
}
