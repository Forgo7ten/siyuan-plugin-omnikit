import {
  CONTAINER_BLOCK_TYPES,
  computeBlockParitySignature,
  type DomElementLike,
} from "../model/BlockDomExtractor.ts";
import type { DocumentSnapshot } from "./KernelSnapshot.ts";

export interface LiveProtyleView {
  block?: { rootID?: string };
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
 * matches the canonical kernel snapshot using the exact same structural signature extractor.
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

  const allNodes = Array.from(wysiwyg.querySelectorAll<HTMLElement>("[data-node-id]"));
  let checkedCount = 0;
  for (const block of allNodes) {
    if (isEmbedBlock(block, wysiwyg)) continue;
    if (!isAtomicLiveBlock(block)) continue;
    // Large tables (>256 rows) virtualize offscreen rows via `tr[data-sy-table-virtual-rows]` in live DOM.
    if (block.getAttribute("data-type") === "NodeTable" && block.querySelector("tr[data-sy-table-virtual-rows]")) {
      checkedCount++;
      continue;
    }
    const id = block.getAttribute("data-node-id");
    if (!id) continue;
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

  return checkedCount > 0 || snapshot.parityByBlockID.size === 0;
}
