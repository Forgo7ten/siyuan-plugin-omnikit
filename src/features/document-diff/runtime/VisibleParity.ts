import {
  CONTAINER_BLOCK_TYPES,
  computeBlockParitySignature,
  type DomElementLike,
} from "../model/BlockDomExtractor.ts";
import type { DocumentSnapshot } from "./KernelSnapshot.ts";

export interface LiveProtyleView {
  block?: {
    rootID?: string;
    id?: string;
    showAll?: boolean;
    scroll?: boolean;
  };
  wysiwyg?: { element?: HTMLElement };
  title?: {
    editElement?: HTMLElement;
    element?: HTMLElement;
    getText?: () => string;
  };
}

function readLiveTitle(view: LiveProtyleView): string | undefined {
  if (typeof view.title?.getText === "function") {
    return view.title.getText();
  }
  if (view.title?.editElement && typeof view.title.editElement.textContent === "string") {
    return view.title.editElement.textContent;
  }
  return undefined;
}

function isEmbedBlock(el: Element, wysiwygRoot: Element): boolean {
  let cur = el.parentElement;
  while (cur && cur !== wysiwygRoot) {
    if (cur.classList?.contains("protyle-wysiwyg__embed")) return true;
    cur = cur.parentElement;
  }
  return false;
}

function isAtomicLiveBlock(el: HTMLElement): boolean {
  const type = el.getAttribute("data-type") ?? "";
  if (!CONTAINER_BLOCK_TYPES.has(type)) return true;
  return !el.querySelector("[data-node-id]");
}

/**
 * Verifies that every atomic block currently mounted in `protyle.wysiwyg.element`
 * matches the canonical kernel snapshot in strictly increasing snapshot order,
 * and matches full atomic block count when the view is neither virtualized nor folded.
 */
export function verifyVisibleParity(
  view: LiveProtyleView,
  snapshot: DocumentSnapshot,
  verifyTitle = true,
): boolean {
  if (view.block?.rootID !== snapshot.id) return false;
  const wysiwyg = view.wysiwyg?.element;
  if (!wysiwyg) return false;

  if (verifyTitle) {
    const liveTitle = readLiveTitle(view);
    if (liveTitle !== undefined && liveTitle !== snapshot.title) {
      if (!(snapshot.titleEmpty && liveTitle === "")) {
        return false;
      }
    }
  }

  const orderByBlockID = new Map<string, number>();
  let nextOrder = 0;
  for (const id of snapshot.parityByBlockID.keys()) {
    orderByBlockID.set(id, nextOrder++);
  }

  const allNodes = Array.from(wysiwyg.querySelectorAll<HTMLElement>("[data-node-id]"));
  let hasFoldedBlock = false;
  let prevOrder = -1;
  let checkedCount = 0;

  for (const block of allNodes) {
    if (isEmbedBlock(block, wysiwyg)) continue;
    if (block.getAttribute("fold") === "1" || block.getAttribute("heading-fold") === "1") {
      hasFoldedBlock = true;
    }
    if (!isAtomicLiveBlock(block)) continue;

    const id = block.getAttribute("data-node-id");
    if (!id) continue;
    const order = orderByBlockID.get(id);
    if (order === undefined || order <= prevOrder) {
      return false;
    }
    prevOrder = order;

    // Large tables (>256 rows) virtualize offscreen rows via `tr[data-sy-table-virtual-rows]` in live DOM.
    if (block.getAttribute("data-type") === "NodeTable" && block.querySelector("tr[data-sy-table-virtual-rows]")) {
      checkedCount++;
      continue;
    }
    const kernelSig = snapshot.parityByBlockID.get(id);
    if (kernelSig === undefined) {
      return false;
    }
    const liveSig = computeBlockParitySignature(
      block as unknown as DomElementLike,
      wysiwyg as unknown as DomElementLike,
    );
    if (liveSig !== kernelSig) {
      return false;
    }
    checkedCount++;
  }

  const isVirtualized = Boolean(view.block?.scroll);
  const isZoomedSubtree = Boolean(view.block?.id && view.block.id !== snapshot.id && !view.block.showAll);
  if (!isVirtualized && !isZoomedSubtree && !hasFoldedBlock) {
    return checkedCount === snapshot.parityByBlockID.size;
  }
  return checkedCount > 0 || snapshot.parityByBlockID.size === 0;
}
