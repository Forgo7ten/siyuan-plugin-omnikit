import { KernelClient } from "../../core/KernelClient.ts";
import { isDocumentRootIdentity, isSafeBlockId, type BlockIdentity } from "./DocumentIdentity.ts";

export interface KernelResponse<T> { code: number; data: T; msg: string; }
const kernel = new KernelClient();
function post<T>(path: string, body: any, signal?: AbortSignal): Promise<KernelResponse<T>> {
  return kernel.post<T>(path, body, { signal });
}

/** @safety Upload creates a new resource; this repository never overwrites or removes originals. */
export class AssetRepository {
  constructor(private readonly notebook?: string) {}

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

  async getBlockDOM(id: string, notebook?: string, signal?: AbortSignal): Promise<string> {
    const box = notebook ?? this.notebook;
    const response = await post<{ id: string; dom: string }>("/api/block/getBlockDOM", { id, ...(box ? { notebook: box } : {}) }, signal);
    if (response.data?.id !== id) throw new Error("SiYuan returned DOM for a different block");
    if (!response.data?.dom?.trim()) throw new Error("SiYuan returned an empty block DOM");
    return response.data.dom;
  }

  /** Read current block metadata from the kernel tree; encrypted notebooks need their ID. */
  async getBlockInfo(id: string): Promise<BlockIdentity | undefined> {
    const response = await post<BlockIdentity>("/api/block/getBlockInfo", { id, ...(this.notebook ? { notebook: this.notebook } : {}) });
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

  /** SQL supplies a block type when available; kernel tree metadata is the fallback. */
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
