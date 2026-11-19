import type { KernelClient } from "../../../core/host/KernelClient.ts";
import { commitOneImage, type CommitResult } from "./SafeBlockWriter.ts";
import type { OccurrenceTarget } from "../policy/contracts.ts";

export interface DocumentRow { id: string; root_id: string; box: string }

export async function blockDOM(k: KernelClient, id: string, notebook: string, signal?: AbortSignal): Promise<string> {
  const data = (await k.post<any>("/api/block/getBlockDOM", { id, notebook }, { signal })).data;
  if (!data || data.id !== id || typeof data.dom !== "string" || !data.dom.trim()) throw new Error("Invalid block DOM response");
  return data.dom;
}

/** Occurrence-scoped block updates only. */
export class ReferenceService {
  constructor(private readonly k: KernelClient, private readonly origin: string) {}

  /** Direct single-position API for callers that already hold an authorized occurrence snapshot. */
  commitOccurrence(target: OccurrenceTarget, newPath: string, signal?: AbortSignal): Promise<CommitResult> {
    return commitOneImage(this.k, target, newPath, this.origin, signal);
  }
}
