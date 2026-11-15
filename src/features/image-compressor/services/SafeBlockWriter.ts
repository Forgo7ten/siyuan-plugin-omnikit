import type { KernelClient } from "../../../core/host/KernelClient.ts";
import type { OccurrenceTarget } from "../policy/contracts.ts";
import { imagePath } from "./ImageOccurrenceResolver.ts";
import { trySource } from "../policy/source.ts";

export type CommitResult = "replaced" | "conflict" | "unknown";

const blockTails = new Map<string, Promise<void>>();

/** Serializes this plugin's writes to one persisted block without retaining idle keys. */
export function withBlockWriteLease<T>(key: string, operation: () => Promise<T>): Promise<T> {
  const previous = blockTails.get(key) ?? Promise.resolve();
  let release!: () => void;
  const hold = new Promise<void>(resolve => { release = resolve; });
  const tail = previous.catch(() => undefined).then(() => hold);
  blockTails.set(key, tail);
  return previous.catch(() => undefined).then(operation).finally(() => {
    release();
    if (blockTails.get(key) === tail) blockTails.delete(key);
  });
}

interface BlockIdentity { rootID?: string; box?: string }
interface BlockDom { id?: string; dom?: string }

async function readIdentity(kernel: KernelClient, target: OccurrenceTarget, signal?: AbortSignal): Promise<boolean> {
  const { data } = await kernel.post<BlockIdentity>("/api/block/getBlockInfo", {
    id: target.blockID, notebook: target.notebook,
  }, { signal });
  // Missing notebook identity is not sufficient evidence for a scoped write.
  return data?.rootID === target.rootID && data.box === target.notebook;
}

async function readDOM(kernel: KernelClient, target: OccurrenceTarget, signal?: AbortSignal): Promise<string | undefined> {
  const { data } = await kernel.post<BlockDom>("/api/block/getBlockDOM", {
    id: target.blockID, notebook: target.notebook,
  }, { signal });
  return data?.id === target.blockID && typeof data.dom === "string" && data.dom.trim() ? data.dom : undefined;
}

function patchOccurrence(dom: string, target: OccurrenceTarget, newPath: string): string | undefined {
  const template = document.createElement("template");
  template.innerHTML = dom;
  const roots = [...template.content.children].filter(node => node.getAttribute("data-node-id") === target.blockID);
  if (template.content.children.length !== 1 || roots.length !== 1) return undefined;
  const block = roots[0];
  if (block.querySelector("[data-node-id]")) return undefined;
  const images = [...block.querySelectorAll("img")];
  const selected = images[target.imageOrdinal];
  if (!selected || imagePath(selected) !== target.oldPath) return undefined;
  const attribute = selected.hasAttribute("data-src") ? "data-src" : "src";
  selected.setAttribute(attribute, newPath);
  // Do not rewrite a thumbnail unless it names the same original asset.
  if (attribute === "data-src" && selected.getAttribute("src") === target.oldPath) {
    selected.setAttribute("src", newPath);
  }
  return block.outerHTML;
}

/** Optimistic occurrence-scoped update. The kernel API has no CAS; ambiguous states are never retried. */
export async function commitOneImage(
  kernel: KernelClient,
  target: OccurrenceTarget,
  newPath: string,
  origin: string,
  signal?: AbortSignal,
): Promise<CommitResult> {
  if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
  const next = trySource(newPath, origin);
  if (!next || next.kind !== "asset") return "conflict";
  const leaseKey = `${target.notebook}/${target.blockID}`;
  return withBlockWriteLease(leaseKey, async () => {
    if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
    try {
      if (!await readIdentity(kernel, target, signal)) return "conflict";
      const current = await readDOM(kernel, target, signal);
      if (!current) return "conflict";
      const patched = patchOccurrence(current, target, newPath);
      if (!patched) return "conflict";
      if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
      try {
        await kernel.post("/api/block/updateBlock", {
          id: target.blockID, dataType: "dom", data: patched, lockType: true,
        }, { signal, timeout: 30_000 });
      } catch {
        // The request may have committed despite a lost response. Never replay it.
        return "unknown";
      }
      try {
        if (!await readIdentity(kernel, target, signal)) return "unknown";
        const after = await readDOM(kernel, target, signal);
        if (!after) return "unknown";
        const verify = document.createElement("template");
        verify.innerHTML = after;
        const roots = [...verify.content.children].filter(node => node.getAttribute("data-node-id") === target.blockID);
        const actual = roots.length === 1 ? [...roots[0].querySelectorAll("img")][target.imageOrdinal] : undefined;
        return actual && imagePath(actual) === newPath ? "replaced" : "unknown";
      } catch {
        return "unknown";
      }
    } catch (error) {
      if (signal?.aborted || (error as { name?: string })?.name === "AbortError") throw error;
      return "conflict";
    }
  });
}
