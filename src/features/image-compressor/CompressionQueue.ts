/**
 * @design Identical content is compressed and uploaded once per batch; the bounded worker
 * pool keeps memory pressure predictable on mobile.
 * @invariant Distinct paths with identical bytes share one result but are all rewritten.
 */
export interface HashableImageWork {
  path: string;
  blob?: Blob;
  groupKey?: string;
  error?: unknown;
}

export async function calculateSHA256(blob: Blob): Promise<string | undefined> {
  if (!globalThis.crypto?.subtle) return undefined;
  const digest = await globalThis.crypto.subtle.digest("SHA-256", await blob.arrayBuffer());
  return [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, "0")).join("");
}

/** Groups identical content once while retaining a path-only fallback when WebCrypto is unavailable. */
export function groupByContentHash<T extends HashableImageWork>(works: T[]): Map<string, T[]> {
  const groups = new Map<string, T[]>();
  for (const work of works) {
    if (work.error || !work.blob) continue;
    const key = work.groupKey ?? `path:${work.path}`;
    const group = groups.get(key) ?? [];
    group.push(work);
    groups.set(key, group);
  }
  return groups;
}

/** Bounded worker pool; workers already in flight may finish after abort, new work will not start. */
export async function runLimited<T>(items: T[], limit: number, worker: (item: T) => Promise<void>, signal?: AbortSignal): Promise<void> {
  let cursor = 0;
  await Promise.all(Array.from({ length: Math.min(Math.max(1, limit), items.length) }, async () => {
    while (!signal?.aborted && cursor < items.length) {
      const index = cursor++;
      await worker(items[index]);
    }
  }));
}
