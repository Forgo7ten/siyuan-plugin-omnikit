import type { KernelClient } from "../../core/KernelClient.ts";
import { NODE_ID, retainOriginal, type ImageConfig, type Intent } from "./parseImageConfig.ts";
import { resolveSource, type ImageSource } from "./source.ts";
import { parseNative, nativeCovered, type ReferenceResult } from "./references.ts";

export async function digest(blob: Blob): Promise<string> {
  const bytes = await crypto.subtle.digest("SHA-256", await blob.arrayBuffer());
  return [...new Uint8Array(bytes)].map(value => value.toString(16).padStart(2, "0")).join("");
}

export class UploadOutcomeUnknown extends Error {
  readonly outcome = "unknown-write";
}

export class AssetStore {
  constructor(private readonly kernel: KernelClient, private readonly origin: string) {}

  async upload(file: File, rootID: string, signal?: AbortSignal): Promise<string> {
    if (!NODE_ID.test(rootID)) throw new Error("Invalid upload document");
    if (signal?.aborted) throw new DOMException("Operation cancelled", "AbortError");
    const form = new FormData();
    form.append("file[]", file, file.name);
    form.append("id", rootID);
    let response;
    try {
      response = await this.kernel.post<any>("/api/asset/upload", form, { signal, timeout: 60_000 });
    } catch (error) {
      // A write transport failure can happen after the kernel accepted the file. Never retry it.
      throw new UploadOutcomeUnknown(error instanceof Error ? error.message : "Upload outcome is unknown");
    }
    const data = response.data;
    if (!data || typeof data !== "object" || Array.isArray(data)) throw new UploadOutcomeUnknown("Upload response is not reliable");
    if (Array.isArray(data.failedFiles) && data.failedFiles.length || Array.isArray(data.errFiles) && data.errFiles.length)
      throw new UploadOutcomeUnknown("Upload failed or was partial");
    let path: unknown;
    if (Array.isArray(data.succFiles)) {
      if (data.succFiles.length === 1 && data.succFiles[0]?.index === 0) path = data.succFiles[0].path;
    } else if (data.succMap && typeof data.succMap === "object" && !Array.isArray(data.succMap)) {
      const entries = Object.entries(data.succMap);
      if (entries.length === 1 && entries[0][0] === file.name) path = entries[0][1];
    }
    if (typeof path !== "string") throw new UploadOutcomeUnknown("Upload returned no exact file mapping");
    try {
      if (resolveSource(path, this.origin).kind !== "asset") throw new Error("non-asset path");
    } catch {
      throw new UploadOutcomeUnknown("Upload returned an invalid resource path");
    }
    return path;
  }

  /** Store the original as a kernel-visible root attribute before returning a replacement. */
  async archive(file: File, rootID: string, signal?: AbortSignal): Promise<string> {
    const path = await this.upload(file, rootID, signal);
    const attribute = `custom-data-assets-omnikit-${crypto.randomUUID().replaceAll("-", "")}`;
    let response;
    try {
      response = await this.kernel.post("/api/attr/setBlockAttrs", { id: rootID, attrs: { [attribute]: path } }, { signal });
    } catch (error) {
      throw new UploadOutcomeUnknown(error instanceof Error ? error.message : "Archive pin outcome is unknown");
    }
    if (response.code !== 0) throw new UploadOutcomeUnknown("Original archive pin was not confirmed");
    const attrs = (await this.kernel.post<any>("/api/attr/getBlockAttrs", { id: rootID }, { signal })).data;
    if (!attrs || typeof attrs !== "object" || attrs[attribute] !== path)
      throw new Error("Original archive pin could not be verified");
    return path;
  }
}

export interface CleanupResult {
  status: "retained" | "removed-from-live-assets" | "unknown";
  reason: string;
}

const REVIEWED_CLEANUP_VERSIONS = new Set(["3.8.9"]);

/** This capability is intentionally separate from document and upload runners. */
export class SingleOriginalFinalizer {
  constructor(private readonly kernel: KernelClient, private readonly hostVersion: string) {}

  async finish(
    intent: Intent,
    config: ImageConfig,
    source: ImageSource,
    replacement: string,
    result: ReferenceResult,
    verifyOriginalUnchanged: () => Promise<boolean>,
    signal?: AbortSignal,
  ): Promise<CleanupResult> {
    const keep = (reason: string): CleanupResult => ({ status: "retained", reason });
    if (intent.kind !== "manual-single") return keep("not-manual-single");
    if (retainOriginal(intent, config)) return keep("retention-setting");
    if (source.kind !== "asset" || source.box) return keep("external-or-encrypted-source");
    if (source.path === replacement) return keep("same-path");
    if (result.backend !== "native" || result.state !== "verified" || !result.cleanupEligible)
      return keep("reference-coverage-insufficient");
    if (!REVIEWED_CLEANUP_VERSIONS.has(this.hostVersion)) return keep("cleanup-contract-not-reviewed");
    if (signal?.aborted) throw new DOMException("Operation cancelled", "AbortError");
    if (!await verifyOriginalUnchanged()) return keep("original-content-changed");

    const found = await this.kernel.post<any>("/api/asset/findAssetReferences", { paths: [source.path] }, { signal, timeout: 120_000 });
    const refs = parseNative(found.data);
    if (refs.items.length !== 1 || refs.items[0].oldPath !== source.path || refs.items[0].newPath !== ""
      || !refs.dryRun || !nativeCovered(refs) || refs.references.length
      || refs.items.some((item: any) => item.references.length)) return keep("references-remain");

    const unused = (await this.kernel.post<unknown>("/api/asset/getUnusedAssets", {}, { signal })).data;
    if (!Array.isArray(unused)) return keep("unused-list-unavailable");
    const decodedPath = decodeURIComponent(source.path);
    const candidates = unused.filter((entry: any) => {
      if (!entry || typeof entry.item !== "string") return false;
      const parts = entry.item.split("/");
      const assetsIndex = parts.indexOf("assets");
      if (assetsIndex < 0 || parts.some((part: string) => !part || part === "." || part === ".." || part.includes("\\"))
        || parts.slice(0, assetsIndex).some((part: string) => !NODE_ID.test(part))) return false;
      return parts.slice(assetsIndex).join("/") === decodedPath;
    });
    if (candidates.length !== 1) return keep("unused-physical-path-ambiguous");
    if (signal?.aborted) throw new DOMException("Operation cancelled", "AbortError");
    try {
      const removed = await this.kernel.post<any>("/api/asset/removeUnusedAsset", { path: candidates[0].item }, { signal, timeout: 120_000 });
      if (typeof removed.data?.path !== "string" || !removed.data.path)
        return { status: "unknown", reason: "cleanup-not-confirmed" };
      return { status: "removed-from-live-assets", reason: "kernel-history-retained; physical disk savings not asserted" };
    } catch {
      return { status: "unknown", reason: "cleanup-result-unknown; do-not-resend" };
    }
  }
}
