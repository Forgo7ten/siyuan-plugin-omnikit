import type { KernelClient } from "../../../core/host/KernelClient.ts";
import { NODE_ID } from "../policy/parseImageConfig.ts";
import { resolveSource } from "../policy/source.ts";

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
      if (signal?.aborted || (error as { name?: string })?.name === "AbortError") throw error;
      // A write transport failure can happen after the kernel accepted the file. Never retry it.
      throw new UploadOutcomeUnknown(error instanceof Error ? error.message : "Upload outcome is unknown");
    }
    if (response.code !== 0) {
      throw new UploadOutcomeUnknown(`Upload failed with code ${response.code}: ${response.msg || ""}`);
    }
    const data = response.data;
    if (!data || typeof data !== "object" || Array.isArray(data)) throw new UploadOutcomeUnknown("Upload response is not reliable");
    if (Array.isArray(data.failedFiles) && data.failedFiles.length > 0) {
      throw new UploadOutcomeUnknown("Upload failed with failedFiles");
    }
    if (Array.isArray(data.errFiles) && data.errFiles.length > 0) {
      throw new UploadOutcomeUnknown("Upload failed with errFiles");
    }
    let path: unknown;
    if (Array.isArray(data.succFiles)) {
      if (data.succFiles.length === 1 && data.succFiles[0]?.index === 0) path = data.succFiles[0].path;
    } else if (data.succMap && typeof data.succMap === "object" && !Array.isArray(data.succMap)) {
      const entries = Object.entries(data.succMap);
      if (entries.length === 1 && entries[0][0] === file.name) path = entries[0][1];
    }
    if (typeof path !== "string") throw new UploadOutcomeUnknown("Upload returned no exact file mapping");
    const normalized = path.replace(/\\/g, "/");
    if (!normalized.startsWith("assets/")) {
      throw new UploadOutcomeUnknown("Upload returned an invalid resource path");
    }
    try {
      if (resolveSource(normalized, this.origin).kind !== "asset") throw new Error("non-asset path");
    } catch {
      throw new UploadOutcomeUnknown("Upload returned an invalid resource path");
    }
    return normalized;
  }
}
