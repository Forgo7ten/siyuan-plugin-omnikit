import { isAbortError } from "../../../core/feedback/UiFeedback.ts";
import type { KernelClient } from "../../../core/host/KernelClient.ts";

export const DEFAULT_DOCUMENT_TITLE_ENDPOINTS = [
  "/api/filetree/getFullHPathByID",
  "/api/filetree/getHPathByID",
] as const;

/**
 * Resolves a human-readable document title for allowlist and Dock displays,
 * falling back to `fallbackRootTitle` and finally `rootID` when title APIs fail.
 */
export async function resolveDocumentTitle(
  kernel: KernelClient,
  rootID: string,
  options: {
    fallbackRootTitle?: string;
    cache?: Map<string, string>;
    signal?: AbortSignal;
    endpoints?: readonly string[];
  } = {},
): Promise<string> {
  const { fallbackRootTitle, cache, signal, endpoints = DEFAULT_DOCUMENT_TITLE_ENDPOINTS } = options;
  const cached = cache?.get(rootID);
  if (cached) return cached;

  let title = "";
  for (const endpoint of endpoints) {
    try {
      const res = await kernel.post<string>(endpoint, { id: rootID }, signal ? { signal } : undefined);
      if (typeof res.data === "string" && res.data.trim()) {
        title = res.data.trim().slice(0, 512);
        break;
      }
    } catch (error) {
      if (signal?.aborted || isAbortError(error)) throw error;
    }
  }

  const fallback = typeof fallbackRootTitle === "string" ? fallbackRootTitle.trim().slice(0, 512) : "";
  const resolved = title || fallback || rootID;
  cache?.set(rootID, resolved);
  return resolved;
}
