import type { App } from "siyuan";
import type { KernelClient } from "../../../core/host/KernelClient.ts";
import type { HostBridge } from "../host/SiyuanBridge.ts";
import { KernelSnapshot } from "./KernelSnapshot.ts";

export interface VisibleDoc {
  id: string;
  notebook: string;
  protyle: any;
  panel: HTMLElement;
  wndElement: HTMLElement;
  tab?: any;
  wndInstance?: any;
  rect: DOMRect;
}

export type PairLayoutErrorCode =
  | "same-document"
  | "no-visible-pair"
  | "not-two-panes"
  | "not-side-by-side"
  | "complex-layout"
  | "open-timeout"
  | "swap-unsupported"
  | "swap-failed";

export class PairLayoutError extends Error {
  constructor(
    readonly code: PairLayoutErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "PairLayoutError";
  }
}

function isElementVisible(el: HTMLElement | undefined | null): el is HTMLElement {
  if (!el || !el.isConnected) return false;
  if (el.closest?.(".fn__none, [hidden], [inert], .block__popover, .b3-dialog")) return false;
  if (el.closest?.(".layout__dockl, .layout__dockr, .layout__dockb")) return false;
  const rects = typeof el.getClientRects === "function" ? el.getClientRects() : [];
  if (!rects || rects.length === 0) return false;
  if (typeof getComputedStyle === "function") {
    const style = getComputedStyle(el);
    if (style.display === "none" || style.visibility === "hidden") return false;
  }
  return true;
}

/**
 * Enumerates active, visible main-workspace document editors (excluding background tabs,
 * search/backlink previews, dialogs, popovers, and read-only history viewers).
 */
export function visibleMainEditors(bridge: HostBridge): VisibleDoc[] {
  const results: VisibleDoc[] = [];
  for (const model of bridge.getEditorModels()) {
    const protyle = model?.editor?.protyle;
    const panel = (model?.element ?? model?.parent?.panelElement) as HTMLElement | undefined;
    const head = (model?.headElement ?? model?.parent?.headElement) as HTMLElement | undefined;
    const rootID = protyle?.block?.rootID;
    const wndElement = panel?.closest?.('[data-type="wnd"]') as HTMLElement | null | undefined;
    if (
      typeof rootID !== "string" ||
      !rootID ||
      !panel ||
      !wndElement ||
      !protyle?.element ||
      !protyle?.wysiwyg?.element ||
      protyle.options?.history ||
      !head?.classList?.contains("item--focus") ||
      !isElementVisible(panel) ||
      !isElementVisible(protyle.element) ||
      !isElementVisible(protyle.wysiwyg.element) ||
      !isElementVisible(wndElement)
    ) {
      continue;
    }
    const tab = model?.parent;
    const wndInstance = tab?.parent;
    const notebook = typeof protyle.notebookId === "string" ? protyle.notebookId : "";
    results.push({
      id: rootID,
      notebook,
      protyle,
      panel,
      wndElement,
      tab,
      wndInstance,
      rect: protyle.element.getBoundingClientRect(),
    });
  }
  return results;
}

export type InspectVisiblePairResult =
  | { ok: true; pair: readonly [VisibleDoc, VisibleDoc] }
  | { ok: false; code: PairLayoutErrorCode };

export function findSideBySidePanes(bridge: HostBridge): InspectVisiblePairResult {
  const editors = visibleMainEditors(bridge);
  if (editors.length !== 2) {
    return { ok: false, code: editors.length === 0 ? "no-visible-pair" : "not-two-panes" };
  }
  if (editors[0]!.wndElement === editors[1]!.wndElement) {
    return { ok: false, code: "not-side-by-side" };
  }
  editors.sort((a, b) => a.rect.left - b.rect.left);
  const [left, right] = editors as [VisibleDoc, VisibleDoc];
  const verticalOverlap = Math.min(left.rect.bottom, right.rect.bottom) - Math.max(left.rect.top, right.rect.top);
  if (verticalOverlap <= 0 || left.rect.left >= right.rect.left || left.rect.right > right.rect.left + 24) {
    return { ok: false, code: "not-side-by-side" };
  }
  return { ok: true, pair: [left, right] };
}

export function inspectVisiblePair(bridge: HostBridge): InspectVisiblePairResult {
  const panes = findSideBySidePanes(bridge);
  if (!panes.ok) return panes;
  if (panes.pair[0].id === panes.pair[1].id) {
    return { ok: false, code: "same-document" };
  }
  return panes;
}

export function findVisiblePair(bridge: HostBridge): readonly [VisibleDoc, VisibleDoc] | null {
  const inspected = inspectVisiblePair(bridge);
  return inspected.ok ? inspected.pair : null;
}

export function canSwapVisiblePair(left: VisibleDoc, right: VisibleDoc): boolean {
  const leftWnd = left.wndInstance;
  const rightWnd = right.wndInstance;
  if (!left.tab || !right.tab || !leftWnd || !rightWnd || leftWnd === rightWnd) return false;
  if (
    typeof leftWnd.moveTab !== "function" ||
    typeof rightWnd.moveTab !== "function" ||
    typeof leftWnd.split !== "function" ||
    typeof leftWnd.switchTab !== "function"
  ) {
    return false;
  }
  const parent = leftWnd.parent;
  if (!parent || parent !== rightWnd.parent || parent.direction !== "lr") return false;
  return Array.isArray(leftWnd.children) && Array.isArray(rightWnd.children);
}

function transferTabToWnd(targetWnd: any, tab: any): void {
  if (tab?.headElement && targetWnd?.headersElement) {
    targetWnd.headersElement.append(tab.headElement);
    targetWnd.headersElement.parentElement?.classList?.remove("fn__none");
  }
  targetWnd.moveTab(tab);
}

/**
 * Swaps the physical left/right document tabs in place using SiYuan's `Wnd` methods
 * without destroying Protyle instances or losing editor undo history.
 */
export function swapVisiblePair(
  left: VisibleDoc,
  right: VisibleDoc,
  bridge: HostBridge,
): readonly [VisibleDoc, VisibleDoc] {
  const current = findVisiblePair(bridge);
  if (!current || current[0].id !== left.id || current[1].id !== right.id) {
    throw new PairLayoutError("swap-unsupported", "Active split panes changed before swap");
  }
  if (!canSwapVisiblePair(current[0], current[1])) {
    throw new PairLayoutError("swap-unsupported", "Host pane layout does not support automatic tab swap");
  }

  const leftTab = current[0].tab;
  const rightTab = current[1].tab;
  const leftWnd = current[0].wndInstance;
  const rightWnd = current[1].wndInstance;

  if (leftWnd.children.length >= 2 && rightWnd.children.length >= 2) {
    transferTabToWnd(leftWnd, rightTab);
    transferTabToWnd(rightWnd, leftTab);
    if (rightTab.headElement) leftWnd.switchTab(rightTab.headElement, false);
    if (leftTab.headElement) rightWnd.switchTab(leftTab.headElement, false);
  } else if (rightWnd.children.length === 1) {
    // Moving the sole tab out of `rightWnd` causes SiYuan (`Wnd.ts:1220`) to remove `rightWnd`;
    // splitting `leftWnd` to the right immediately restores the two-column layout with `leftTab` on the right.
    transferTabToWnd(leftWnd, rightTab);
    const newRightWnd = leftWnd.split("lr", true);
    transferTabToWnd(newRightWnd, leftTab);
    if (rightTab.headElement) leftWnd.switchTab(rightTab.headElement, false);
    if (leftTab.headElement) newRightWnd.switchTab(leftTab.headElement, false);
  } else {
    // `leftWnd` has 1 tab and `rightWnd` has >= 2 tabs: move `rightTab` into `leftWnd` first (so `leftWnd` has 2),
    // then move `leftTab` into `rightWnd`. Neither `Wnd` ever hits 0 tabs.
    transferTabToWnd(leftWnd, rightTab);
    transferTabToWnd(rightWnd, leftTab);
    if (rightTab.headElement) leftWnd.switchTab(rightTab.headElement, false);
    if (leftTab.headElement) rightWnd.switchTab(leftTab.headElement, false);
  }

  const after = findVisiblePair(bridge);
  if (!after || after[0].id !== right.id || after[1].id !== left.id) {
    throw new PairLayoutError("swap-failed", "Failed to verify physical left/right pane order after swap");
  }
  return after;
}

function findTabInWnd(wnd: any, docID: string): any | undefined {
  if (!Array.isArray(wnd?.children)) return undefined;
  return wnd.children.find(
    (tab: any) => tab?.model?.editor?.protyle?.block?.rootID === docID,
  );
}

function focusWnd(wnd: any): void {
  if (!wnd || !Array.isArray(wnd.children)) return;
  const activeTab = wnd.children.find((t: any) => t?.headElement?.classList?.contains("item--focus")) ?? wnd.children[0];
  if (activeTab?.headElement && typeof wnd.switchTab === "function") {
    wnd.switchTab(activeTab.headElement, false);
  }
}

async function delayWithSignal(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return;
  await new Promise<void>(resolve => {
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      resolve();
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

/**
 * Opens `(leftID, rightID)` in native left/right editable panes without closing existing tabs,
 * supporting both single-pane workspaces and existing two-column split workspaces.
 */
export async function openAndVerifyPair(
  app: App,
  leftID: string,
  rightID: string,
  kernel: KernelClient,
  bridge: HostBridge,
  signal: AbortSignal,
): Promise<readonly [VisibleDoc, VisibleDoc]> {
  if (leftID === rightID) {
    throw new PairLayoutError("same-document", "Comparison requires two distinct documents");
  }
  if (signal.aborted) {
    throw new DOMException("Aborted", "AbortError");
  }

  // Verify both target documents exist and can be read before touching workspace tabs.
  const snapshotReader = new KernelSnapshot(kernel, signal);
  await Promise.all([
    snapshotReader.verifyDocumentReadable(leftID),
    snapshotReader.verifyDocumentReadable(rightID),
  ]);
  if (signal.aborted) {
    throw new DOMException("Aborted", "AbortError");
  }

  const editors = visibleMainEditors(bridge);
  if (editors.length > 2) {
    throw new PairLayoutError("complex-layout", "Workspace has more than two visible editor panes");
  }

  const sideBySide = findSideBySidePanes(bridge);
  if (sideBySide.ok) {
    const existingPair = sideBySide.pair;
    if (existingPair[0].id === leftID && existingPair[1].id === rightID) {
      return existingPair;
    }
    if (existingPair[0].id === rightID && existingPair[1].id === leftID && canSwapVisiblePair(existingPair[0], existingPair[1])) {
      return swapVisiblePair(existingPair[0], existingPair[1], bridge);
    }

    // Existing two-column layout: place `leftID` in `leftWnd` and `rightID` in `rightWnd` without closing tabs.
    const leftWnd = existingPair[0].wndInstance;
    const rightWnd = existingPair[1].wndInstance;
    if (leftWnd && rightWnd && leftWnd !== rightWnd) {
      let rightAlreadyOpened = false;
      // Step 1: Ensure `leftID` is active in `leftWnd`.
      const leftInLeft = findTabInWnd(leftWnd, leftID);
      const leftInRight = findTabInWnd(rightWnd, leftID);
      if (leftInLeft?.headElement && typeof leftWnd.switchTab === "function") {
        leftWnd.switchTab(leftInLeft.headElement, false);
      } else if (leftInRight && rightWnd.children?.length > 1 && typeof leftWnd.moveTab === "function") {
        transferTabToWnd(leftWnd, leftInRight);
      } else {
        focusWnd(leftWnd);
        const openedLeft = await bridge.openDocTab({ app, id: leftID, removeCurrentTab: false });
        if (openedLeft && openedLeft.parent === rightWnd && rightWnd.children?.length > 1 && typeof leftWnd.moveTab === "function") {
          transferTabToWnd(leftWnd, openedLeft);
        } else if (openedLeft && openedLeft.parent === rightWnd && rightWnd.children?.length === 1 && typeof leftWnd.moveTab === "function") {
          transferTabToWnd(leftWnd, openedLeft);
          focusWnd(leftWnd);
          await bridge.openDocTab({ app, id: rightID, position: "right", removeCurrentTab: false });
          rightAlreadyOpened = true;
        }
      }

      if (signal.aborted) throw new DOMException("Aborted", "AbortError");

      // Step 2: Re-inspect panes and ensure `rightID` is active in the right pane.
      if (!rightAlreadyOpened) {
        const midPanes = findSideBySidePanes(bridge);
        if (midPanes.ok) {
          const curLeftWnd = midPanes.pair[0].wndInstance;
          const curRightWnd = midPanes.pair[1].wndInstance;
          const rightInRight = findTabInWnd(curRightWnd, rightID);
          const rightInLeft = findTabInWnd(curLeftWnd, rightID);
          if (rightInRight?.headElement && typeof curRightWnd?.switchTab === "function") {
            curRightWnd.switchTab(rightInRight.headElement, false);
          } else if (rightInLeft && curLeftWnd?.children?.length > 1 && typeof curRightWnd?.moveTab === "function") {
            transferTabToWnd(curRightWnd, rightInLeft);
          } else {
            focusWnd(curLeftWnd);
            const openedRight = await bridge.openDocTab({ app, id: rightID, position: "right", removeCurrentTab: false });
            if (openedRight && openedRight.parent === curLeftWnd && curLeftWnd?.children?.length > 1 && typeof curRightWnd?.moveTab === "function") {
              transferTabToWnd(curRightWnd, openedRight);
            }
          }
        } else {
          await bridge.openDocTab({ app, id: rightID, position: "right", removeCurrentTab: false });
        }
      }
    } else {
      await bridge.openDocTab({ app, id: leftID, removeCurrentTab: false });
      if (signal.aborted) throw new DOMException("Aborted", "AbortError");
      await bridge.openDocTab({ app, id: rightID, position: "right", removeCurrentTab: false });
    }
  } else if (editors.length === 2) {
    // Two visible editors that are not side-by-side (e.g. top/bottom split).
    throw new PairLayoutError("complex-layout", "Visible editors are arranged vertically rather than side by side");
  } else {
    // Single-pane (or empty) workspace.
    await bridge.openDocTab({ app, id: leftID, removeCurrentTab: false });
    if (signal.aborted) throw new DOMException("Aborted", "AbortError");
    await bridge.openDocTab({ app, id: rightID, position: "right", removeCurrentTab: false });
  }

  for (let attempt = 0; attempt < 25 && !signal.aborted; attempt++) {
    const pair = findVisiblePair(bridge);
    if (pair && pair[0].id === leftID && pair[1].id === rightID) {
      return pair;
    }
    await delayWithSignal(100, signal);
  }
  if (signal.aborted) {
    throw new DOMException("Aborted", "AbortError");
  }
  throw new PairLayoutError("open-timeout", "Unable to verify expected left/right split editors");
}
