import type { KernelClient } from "../../../core/host/KernelClient.ts";
import { getKernelOutcome } from "../../../core/host/kernelOutcome.ts";
import { withBlockWriteLease } from "../../../core/host/BlockWriteLease.ts";
import { isAbortError } from "../../../core/feedback/UiFeedback.ts";
import type { OccurrenceTarget } from "../policy/contracts.ts";
import { findLinkCandidates, parseSingleLeafBlock } from "../policy/dom.ts";
import { buildReplacementPath, imageSourceAttribute, resolveSource } from "../policy/source.ts";

export type CommitResult = "replaced" | "conflict" | "aborted" | "failed" | "unknown";

export type ConflictReason =
  | "identity-mismatch"
  | "missing-dom"
  | "nested-block"
  | "ordinal-mismatch"
  | "path-mismatch";

export interface CommitDetailedResult {
  status: CommitResult;
  conflictReason?: ConflictReason;
}

interface BlockIdentity { rootID?: string; box?: string }
interface BlockDom { id?: string; dom?: string }

export async function blockDOM(kernel: KernelClient, id: string, notebook: string, signal?: AbortSignal): Promise<string> {
  const { data } = await kernel.post<BlockDom>("/api/block/getBlockDOM", { id, notebook }, { signal });
  if (!data || data.id !== id || typeof data.dom !== "string" || !data.dom.trim()) {
    throw new Error("Invalid block DOM response");
  }
  return data.dom;
}

function stripParentHeading(block: Element): void {
  block.removeAttribute("parent-heading");
  for (const el of block.querySelectorAll("[parent-heading]")) {
    el.removeAttribute("parent-heading");
  }
}

async function readIdentity(kernel: KernelClient, target: OccurrenceTarget, signal?: AbortSignal): Promise<boolean> {
  const { data } = await kernel.post<BlockIdentity>("/api/block/getBlockInfo", {
    id: target.blockID, notebook: target.notebook,
  }, { signal });
  // 缺少笔记本身份信息时不能执行限定作用域的写入。
  return data?.rootID === target.rootID && data.box === target.notebook;
}

async function readDOM(kernel: KernelClient, target: OccurrenceTarget, signal?: AbortSignal): Promise<string | undefined> {
  const { data } = await kernel.post<BlockDom>("/api/block/getBlockDOM", {
    id: target.blockID, notebook: target.notebook,
  }, { signal });
  return data?.id === target.blockID && typeof data.dom === "string" && data.dom.trim() ? data.dom : undefined;
}

type PatchOutcome =
  | { ok: true; writeDOM: string }
  | { ok: false; reason: "nested-block" | "ordinal-mismatch" | "path-mismatch" };

function patchOccurrence(
  dom: string,
  target: OccurrenceTarget,
  newPath: string,
  origin: string,
): PatchOutcome {
  const block = parseSingleLeafBlock(dom, target.blockID);
  if (!block) return { ok: false, reason: "nested-block" };

  const replacement = buildReplacementPath(target.oldPath, newPath, origin);

  if (target.kind === "link") {
    const candidates = findLinkCandidates(block);
    const selected = candidates[target.imageOrdinal];
    if (!selected) return { ok: false, reason: "ordinal-mismatch" };
    if (target.attribute && selected.attribute !== target.attribute) return { ok: false, reason: "path-mismatch" };
    if (selected.element.getAttribute(selected.attribute) !== target.oldPath) return { ok: false, reason: "path-mismatch" };
    selected.element.setAttribute(selected.attribute, replacement);
  } else {
    const images = [...block.querySelectorAll("img")];
    const selected = images[target.imageOrdinal];
    if (!selected) return { ok: false, reason: "ordinal-mismatch" };
    if (imageSourceAttribute(selected) !== target.oldPath) return { ok: false, reason: "path-mismatch" };
    const attribute = selected.hasAttribute("data-src") ? "data-src" : "src";
    selected.setAttribute(attribute, replacement);
    // 仅当缩略图与原图指向同一资源时才同步替换，避免误改不同缩略图路径。
    if (attribute === "data-src" && selected.getAttribute("src") === target.oldPath) {
      selected.setAttribute("src", replacement);
    }
  }

  // 仅剥离内核渲染期的只读属性 parent-heading，保留块内其余文字、节点及实时属性。
  stripParentHeading(block);
  return { ok: true, writeDOM: block.outerHTML };
}

/**
 * 通过 Core 共享块写入租约串行提交单处节点替换。
 * 写前核验块归属、单块无嵌套边界以及实时块内目标序号节点的源路径与 oldPath 一致，随后仅改写目标节点属性。
 */
export async function commitOneImageDetailed(
  kernel: KernelClient,
  target: OccurrenceTarget,
  newPath: string,
  origin: string,
  signal?: AbortSignal,
): Promise<CommitDetailedResult> {
  if (signal?.aborted) return { status: "aborted" };
  const next = resolveSource(newPath, origin);
  const replacementInput = next.kind === "asset" ? next.kernelPath : next.url;

  try {
    return await withBlockWriteLease(target.notebook, target.blockID, signal, async () => {
      const identityMatched = await readIdentity(kernel, target, signal);
      if (!identityMatched) return { status: "conflict", conflictReason: "identity-mismatch" };

      const current = await readDOM(kernel, target, signal);
      if (!current) return { status: "conflict", conflictReason: "missing-dom" };

      const patched = patchOccurrence(current, target, replacementInput, origin);
      if (!patched.ok) return { status: "conflict", conflictReason: patched.reason };
      if (signal?.aborted) return { status: "aborted" };

      try {
        await kernel.post("/api/block/updateBlock", {
          id: target.blockID, dataType: "dom", data: patched.writeDOM, lockType: true,
        }, { signal, timeout: 30_000 });
        return { status: "replaced" };
      } catch (error) {
        const outcome = getKernelOutcome(error);
        if (outcome === "not-sent") {
          return { status: "aborted" };
        }
        if (outcome === "rejected") {
          return { status: "failed" };
        }
        // 请求发出后因超时或断连无法确认是否落盘，返回 unknown 且禁止自动重试。
        return { status: "unknown" };
      }
    });
  } catch (error) {
    if (signal?.aborted || isAbortError(error)) return { status: "aborted" };
    throw error;
  }
}

/**
 * 通过 Core 共享块写入租约执行目标节点替换（仅返回五态结果）。
 * 内核接口不提供原子 CAS，读失败显式上抛、写前中止返回 aborted、明确拒写返回 failed、结果不明返回 unknown。
 */
export async function commitOneImage(
  kernel: KernelClient,
  target: OccurrenceTarget,
  newPath: string,
  origin: string,
  signal?: AbortSignal,
): Promise<CommitResult> {
  return (await commitOneImageDetailed(kernel, target, newPath, origin, signal)).status;
}

/** Occurrence-scoped block updates only. */
export class ReferenceService {
  constructor(private readonly k: KernelClient, private readonly origin: string) {}

  /** Direct single-position API for callers that already hold an authorized occurrence snapshot. */
  commitOccurrence(target: OccurrenceTarget, newPath: string, signal?: AbortSignal): Promise<CommitResult> {
    return commitOneImage(this.k, target, newPath, this.origin, signal);
  }

  /** 与 commitOccurrence 相同，并在冲突时附带诊断原因。 */
  commitOccurrenceDetailed(target: OccurrenceTarget, newPath: string, signal?: AbortSignal): Promise<CommitDetailedResult> {
    return commitOneImageDetailed(this.k, target, newPath, this.origin, signal);
  }
}
