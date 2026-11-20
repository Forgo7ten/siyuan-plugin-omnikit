import type { KernelClient } from "../../../core/host/KernelClient.ts";
import { withBlockWriteLease } from "../../../core/host/BlockWriteLease.ts";
import { isAbortError } from "../../../core/feedback/UiFeedback.ts";
import type { OccurrenceTarget } from "../policy/contracts.ts";
import { findLinkCandidates } from "../policy/dom.ts";
import { buildReplacementPath, trySource } from "../policy/source.ts";
import { imagePath } from "./ImageOccurrenceResolver.ts";

export type CommitResult = "replaced" | "conflict" | "aborted" | "unknown";

interface BlockIdentity { rootID?: string; box?: string }
interface BlockDom { id?: string; dom?: string }

function stripRenderOnlyAttributes(block: Element): void {
  if (typeof (block as { removeAttribute?: unknown }).removeAttribute === "function") {
    block.removeAttribute("parent-heading");
  }
  if (typeof (block as { querySelectorAll?: unknown }).querySelectorAll === "function") {
    for (const el of block.querySelectorAll("[parent-heading]")) {
      if (typeof (el as { removeAttribute?: unknown }).removeAttribute === "function") {
        el.removeAttribute("parent-heading");
      }
    }
  }
}

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

function patchOccurrence(dom: string, target: OccurrenceTarget, newPath: string, origin: string): string | undefined {
  const template = document.createElement("template");
  template.innerHTML = dom;
  const roots = [...template.content.children].filter(node => node.getAttribute("data-node-id") === target.blockID);
  if (template.content.children.length !== 1 || roots.length !== 1) return undefined;
  const block = roots[0];
  if (block.querySelector("[data-node-id]")) return undefined;

  const replacement = buildReplacementPath(target.oldPath, newPath, origin);

  if (target.kind === "link") {
    const candidates = findLinkCandidates(block);
    const selected = candidates[target.imageOrdinal];
    if (!selected) return undefined;
    if (target.attribute && selected.attribute !== target.attribute) return undefined;
    if (selected.element.getAttribute(selected.attribute) !== target.oldPath) return undefined;
    selected.element.setAttribute(selected.attribute, replacement);
    stripRenderOnlyAttributes(block);
    return block.outerHTML;
  }

  const images = [...block.querySelectorAll("img")];
  const selected = images[target.imageOrdinal];
  if (!selected || imagePath(selected) !== target.oldPath) return undefined;
  const attribute = selected.hasAttribute("data-src") ? "data-src" : "src";
  selected.setAttribute(attribute, replacement);
  // Do not rewrite a thumbnail unless it names the same original asset.
  if (attribute === "data-src" && selected.getAttribute("src") === target.oldPath) {
    selected.setAttribute("src", replacement);
  }
  stripRenderOnlyAttributes(block);
  return block.outerHTML;
}

/**
 * Optimistic occurrence-scoped update serialized via Core shared block write lease.
 * The kernel API has no CAS; read failures propagate explicitly, pre-write aborts return
 * "aborted", and post-dispatch write uncertainties return "unknown" without retrying.
 */
export async function commitOneImage(
  kernel: KernelClient,
  target: OccurrenceTarget,
  newPath: string,
  origin: string,
  signal?: AbortSignal,
): Promise<CommitResult> {
  if (signal?.aborted) return "aborted";
  const next = trySource(newPath, origin);
  if (!next || next.kind !== "asset") return "conflict";

  try {
    return await withBlockWriteLease(target.notebook, target.blockID, signal, async () => {
      if (signal?.aborted) return "aborted";

      let identityMatched: boolean;
      try {
        identityMatched = await readIdentity(kernel, target, signal);
      } catch (error) {
        if (signal?.aborted || isAbortError(error)) return "aborted";
        throw error;
      }
      if (!identityMatched) return "conflict";

      let current: string | undefined;
      try {
        current = await readDOM(kernel, target, signal);
      } catch (error) {
        if (signal?.aborted || isAbortError(error)) return "aborted";
        throw error;
      }
      if (!current) return "conflict";
      if (current !== target.baselineBlockDOM) return "conflict";

      const patched = patchOccurrence(current, target, next.kernelPath, origin);
      if (!patched) return "conflict";
      if (signal?.aborted) return "aborted";

      try {
        await kernel.post("/api/block/updateBlock", {
          id: target.blockID, dataType: "dom", data: patched, lockType: true,
        }, { signal, timeout: 30_000 });
        return "replaced";
      } catch {
        // The request may have committed despite a lost response, timeout, or abort. Never replay it.
        return "unknown";
      }
    });
  } catch (error) {
    if (signal?.aborted || isAbortError(error)) return "aborted";
    throw error;
  }
}
